import type { AIProvider, Finding, FixResult } from './types';
import { buildPrompt, parseFixResponse } from './prompt';

export class ClaudeProvider implements AIProvider {
    name = 'Claude (Anthropic)';
    private apiKey: string;

    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    async generateFix(params: {
        finding: Finding;
        sourceCode: string;
        filePath: string;
        projectContext: { url: string; techStack: string[] };
    }): Promise<FixResult> {
        const prompt = buildPrompt(params);

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 4096,
                messages: [{ role: 'user', content: prompt }],
            }),
        });

        if (!response.ok) {
            throw new Error(`Claude API error: ${response.status} ${await response.text()}`);
        }

        const data = await response.json() as { content?: { text?: string }[] };
        const text = data.content?.[0]?.text || '';
        return parseFixResponse(text, params.finding, params.filePath);
    }
}
