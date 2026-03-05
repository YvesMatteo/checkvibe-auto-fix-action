export interface Finding {
    scannerKey: string;
    id: string;
    title: string;
    severity: string;
    description: string;
    recommendation: string;
    evidence: string;
    location: string;
    category: string;
}

export interface FixResult {
    finding: Finding;
    type: 'fix' | 'false_positive';
    filePath?: string;
    originalCode?: string;
    fixedCode?: string;
    explanation: string;
    confidence: number;
}

export interface AIProvider {
    name: string;
    generateFix(params: {
        finding: Finding;
        sourceCode: string;
        filePath: string;
        projectContext: { url: string; techStack: string[] };
    }): Promise<FixResult>;
}

export interface ScanData {
    jobId: string;
    scanId: string;
    url: string;
    overallScore: number;
    aiProvider: string;
    project: { url: string; githubRepo: string };
    findings: Finding[];
}
