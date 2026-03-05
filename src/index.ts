import * as core from '@actions/core';
import * as github from '@actions/github';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { ClaudeProvider } from './providers/claude';
import { OpenAIProvider } from './providers/openai';
import { GeminiProvider } from './providers/gemini';
import type { AIProvider, Finding, FixResult, ScanData } from './providers/types';

async function run() {
    const dispatchToken = core.getInput('dispatch_token', { required: true });
    const jobId = core.getInput('job_id', { required: true });
    const apiUrl = core.getInput('checkvibe_api_url', { required: true });
    const aiApiKey = core.getInput('ai_api_key', { required: true });

    let scanData: ScanData;

    try {
        // Step 1: Fetch scan data from CheckVibe
        core.info('Fetching scan data from CheckVibe...');
        const scanRes = await fetch(`${apiUrl}/api/auto-fix/scan-data?token=${dispatchToken}`);
        if (!scanRes.ok) {
            throw new Error(`Failed to fetch scan data: ${scanRes.status} ${await scanRes.text()}`);
        }
        scanData = await scanRes.json() as ScanData;
        core.info(`Found ${scanData.findings.length} findings to analyze`);

        if (scanData.findings.length === 0) {
            core.info('No actionable findings. Done.');
            await reportResults(apiUrl, dispatchToken, [], []);
            return;
        }

        // Step 2: Initialize AI provider
        const provider = createProvider(scanData.aiProvider, aiApiKey);
        core.info(`Using AI provider: ${provider.name}`);

        // Step 3: Detect tech stack + process findings
        const repoRoot = process.env.GITHUB_WORKSPACE || '.';
        const techStack = detectTechStack(repoRoot);
        core.info(`Detected tech stack: ${techStack.join(', ') || 'none'}`);

        const fixes: FixResult[] = [];
        const falsePositives: FixResult[] = [];

        for (const finding of scanData.findings) {
            core.info(`\nAnalyzing: [${finding.severity.toUpperCase()}] ${finding.title}`);

            try {
                // Find relevant source files
                const relevantFiles = findRelevantFiles(repoRoot, finding);
                if (relevantFiles.length === 0) {
                    core.warning(`  No relevant source files found, skipping`);
                    continue;
                }

                const targetFile = relevantFiles[0];
                const sourceCode = fs.readFileSync(targetFile, 'utf-8');
                const relativePath = path.relative(repoRoot, targetFile);

                const result = await provider.generateFix({
                    finding,
                    sourceCode,
                    filePath: relativePath,
                    projectContext: { url: scanData.project.url, techStack },
                });

                if (result.type === 'fix' && result.originalCode && result.fixedCode) {
                    const updatedCode = sourceCode.replace(result.originalCode, result.fixedCode);
                    if (updatedCode !== sourceCode) {
                        fs.writeFileSync(targetFile, updatedCode, 'utf-8');
                        fixes.push(result);
                        core.info(`  FIXED: ${result.explanation}`);
                    } else {
                        core.warning(`  Could not apply fix (original code not found in file)`);
                    }
                } else if (result.type === 'false_positive') {
                    falsePositives.push(result);
                    core.info(`  FALSE POSITIVE: ${result.explanation}`);
                }
            } catch (err: any) {
                core.warning(`  Error processing "${finding.title}": ${err.message}`);
            }
        }

        core.info(`\n--- Results ---`);
        core.info(`Fixed: ${fixes.length}`);
        core.info(`False positives: ${falsePositives.length}`);

        // Step 4: If fixes exist, create branch + PR
        let prUrl: string | undefined;
        let branchName: string | undefined;

        if (fixes.length > 0) {
            const shortId = jobId.slice(0, 8);
            branchName = `checkvibe/fix-${shortId}`;

            // Configure git
            execSync('git config user.name "CheckVibe Auto-Fix"', { cwd: repoRoot });
            execSync('git config user.email "autofix@checkvibe.dev"', { cwd: repoRoot });

            // Create branch, commit, push
            execSync(`git checkout -b ${branchName}`, { cwd: repoRoot });
            execSync('git add -A', { cwd: repoRoot });

            const commitMsg = `fix: auto-fix ${fixes.length} security vulnerabilities

Fixed by CheckVibe Auto-Fix Agent
Job: ${jobId}
Scan: ${scanData.scanId}`;

            execSync(`git commit -m ${JSON.stringify(commitMsg)}`, { cwd: repoRoot });
            execSync(`git push origin ${branchName}`, { cwd: repoRoot });

            // Create PR
            const octokit = github.getOctokit(process.env.GITHUB_TOKEN || '');
            const { owner, repo } = github.context.repo;
            const prBody = generatePRBody(scanData, fixes, falsePositives);

            const { data: pr } = await octokit.rest.pulls.create({
                owner,
                repo,
                title: `fix: CheckVibe auto-fix ${fixes.length} security ${fixes.length === 1 ? 'vulnerability' : 'vulnerabilities'}`,
                body: prBody,
                head: branchName,
                base: 'main',
            });

            prUrl = pr.html_url;
            core.info(`\nPR created: ${prUrl}`);
        } else {
            core.info('\nNo code fixes applied. No PR needed.');
        }

        // Step 5: Report results back to CheckVibe
        await reportResults(apiUrl, dispatchToken, fixes, falsePositives, prUrl, branchName);
        core.info('Results reported to CheckVibe.');

    } catch (err: any) {
        core.setFailed(err.message);
        // Best-effort error report
        try {
            await fetch(`${apiUrl}/api/auto-fix/results?token=${dispatchToken}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: err.message }),
            });
        } catch { /* ignore */ }
    }
}

function createProvider(name: string, apiKey: string): AIProvider {
    switch (name) {
        case 'claude': return new ClaudeProvider(apiKey);
        case 'openai': return new OpenAIProvider(apiKey);
        case 'gemini': return new GeminiProvider(apiKey);
        default: throw new Error(`Unknown AI provider: ${name}. Expected: claude, openai, or gemini.`);
    }
}

function detectTechStack(repoRoot: string): string[] {
    const stack: string[] = [];
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.next) stack.push('Next.js');
        if (deps.react) stack.push('React');
        if (deps['@supabase/supabase-js']) stack.push('Supabase');
        if (deps.firebase) stack.push('Firebase');
        if (deps.convex) stack.push('Convex');
        if (deps.express) stack.push('Express');
        if (deps.tailwindcss) stack.push('Tailwind CSS');
        if (deps.stripe) stack.push('Stripe');
        if (deps.prisma || deps['@prisma/client']) stack.push('Prisma');
        if (deps.drizzle || deps['drizzle-orm']) stack.push('Drizzle');
    } catch { /* no package.json */ }
    return stack;
}

function findRelevantFiles(repoRoot: string, finding: Finding): string[] {
    const files: string[] = [];
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.env', '.env.local'];
    const skipDirs = new Set(['node_modules', '.next', '.git', 'dist', 'build', '.vercel', '.cache', 'coverage']);

    const locationHint = finding.location || finding.evidence || '';

    function walk(dir: string, depth = 0) {
        if (depth > 5) return;
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (skipDirs.has(entry.name)) continue;
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(fullPath, depth + 1);
                } else if (extensions.some(ext => entry.name.endsWith(ext))) {
                    files.push(fullPath);
                }
            }
        } catch { /* permission error */ }
    }

    walk(repoRoot);

    // Sort by relevance: location hint match > config files > others
    return files.sort((a, b) => {
        const aRel = path.relative(repoRoot, a);
        const bRel = path.relative(repoRoot, b);

        // Priority 1: matches location hint from finding
        const aMatch = locationHint && aRel.includes(locationHint) ? -10 : 0;
        const bMatch = locationHint && bRel.includes(locationHint) ? -10 : 0;
        if (aMatch !== bMatch) return aMatch - bMatch;

        // Priority 2: config/middleware files for header/config findings
        const configPatterns = ['next.config', 'middleware', '.env', 'supabase'];
        const findingIsConfig = ['security_headers', 'cors', 'csrf', 'cookie'].includes(finding.scannerKey);
        if (findingIsConfig) {
            const aIsConfig = configPatterns.some(c => aRel.includes(c)) ? -5 : 0;
            const bIsConfig = configPatterns.some(c => bRel.includes(c)) ? -5 : 0;
            if (aIsConfig !== bIsConfig) return aIsConfig - bIsConfig;
        }

        // Priority 3: src/ files over root files
        const aIsSrc = aRel.startsWith('src/') ? -1 : 0;
        const bIsSrc = bRel.startsWith('src/') ? -1 : 0;
        return aIsSrc - bIsSrc;
    });
}

function generatePRBody(
    scanData: ScanData,
    fixes: FixResult[],
    falsePositives: FixResult[]
): string {
    let body = `## CheckVibe Security Fixes\n\n`;
    body += `**Scan ID:** \`${scanData.scanId}\` | **Score:** ${scanData.overallScore}\n\n`;

    if (fixes.length > 0) {
        body += `### Fixed (${fixes.length} ${fixes.length === 1 ? 'vulnerability' : 'vulnerabilities'})\n`;
        for (const fix of fixes) {
            body += `- **${fix.finding.severity}:** ${fix.finding.title}`;
            if (fix.filePath) body += ` in \`${fix.filePath}\``;
            body += `\n  → ${fix.explanation}\n`;
        }
        body += '\n';
    }

    if (falsePositives.length > 0) {
        body += `### Dismissed as false positives (${falsePositives.length} ${falsePositives.length === 1 ? 'finding' : 'findings'})\n`;
        for (const fp of falsePositives) {
            body += `- **${fp.finding.category}:** ${fp.finding.title}\n`;
            body += `  → ${fp.explanation}\n`;
        }
        body += '\n';
    }

    body += `---\nFixed by [CheckVibe](https://checkvibe.dev) — Security for vibe-coded apps\n`;
    return body;
}

async function reportResults(
    apiUrl: string,
    token: string,
    fixes: FixResult[],
    falsePositives: FixResult[],
    prUrl?: string,
    branchName?: string,
) {
    const payload = {
        fixes: fixes.map(f => ({
            scannerKey: f.finding.scannerKey,
            id: f.finding.id,
            severity: f.finding.severity,
            title: f.finding.title,
            explanation: f.explanation,
            filePath: f.filePath,
        })),
        falsePositives: falsePositives.map(fp => ({
            scannerKey: fp.finding.scannerKey,
            id: fp.finding.id,
            severity: fp.finding.severity,
            title: fp.finding.title,
            explanation: fp.explanation,
        })),
        prUrl,
        branchName,
    };

    const res = await fetch(`${apiUrl}/api/auto-fix/results?token=${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    if (!res.ok) {
        console.error('Failed to report results to CheckVibe:', await res.text());
    }
}

run();
