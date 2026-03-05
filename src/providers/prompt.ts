import type { Finding, FixResult } from './types';

/** Build a unified prompt for all AI providers */
export function buildPrompt(params: {
    finding: Finding;
    sourceCode: string;
    filePath: string;
    projectContext: { url: string; techStack: string[] };
}): string {
    const { finding, sourceCode, filePath, projectContext } = params;

    return `You are a security engineer fixing vulnerabilities in a web application.

PROJECT CONTEXT:
- URL: ${projectContext.url}
- Tech stack: ${projectContext.techStack.join(', ') || 'Unknown'}

VULNERABILITY:
- Type: ${finding.category}
- Severity: ${finding.severity}
- Scanner: ${finding.scannerKey}
- Title: ${finding.title}
- Description: ${finding.description}
- Location: ${finding.location}
- Recommendation: ${finding.recommendation}
- Evidence: ${finding.evidence}

SOURCE CODE (${filePath}):
\`\`\`
${sourceCode.slice(0, 8000)}
\`\`\`

INSTRUCTIONS:
1. Analyze whether this is a REAL vulnerability or a FALSE POSITIVE in this specific code context.
2. If REAL: provide the exact code fix with minimal changes. Only fix the security issue, do not refactor or change unrelated code.
3. If FALSE POSITIVE: explain why with specific evidence from the code.
4. Rate your confidence from 0.0 to 1.0.

IMPORTANT: The "original_code" must be an EXACT substring of the source code above so it can be found and replaced.

Respond in JSON only (no markdown wrapping, no explanation outside JSON):
{
  "type": "fix" | "false_positive",
  "explanation": "One sentence explaining the fix or why it is a false positive",
  "file_path": "${filePath}",
  "original_code": "exact lines to replace (only if type=fix)",
  "fixed_code": "replacement code (only if type=fix)",
  "confidence": 0.95
}`;
}

/** Parse AI response into a FixResult */
export function parseFixResponse(text: string, finding: Finding, filePath: string): FixResult {
    // Handle potential markdown wrapping
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
        throw new Error('Failed to parse AI response as JSON');
    }

    const result = JSON.parse(jsonMatch[0]);

    return {
        finding,
        type: result.type === 'false_positive' ? 'false_positive' : 'fix',
        filePath: result.file_path || filePath,
        originalCode: result.original_code || undefined,
        fixedCode: result.fixed_code || undefined,
        explanation: result.explanation || 'No explanation provided',
        confidence: typeof result.confidence === 'number' ? result.confidence : 0.5,
    };
}
