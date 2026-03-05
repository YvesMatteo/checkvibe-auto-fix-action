import type { AIProvider, Finding, FixResult } from './types';
import { buildPrompt, parseFixResponse } from './prompt';

export class OpenAIProvider implements AIProvider {
    name = 'OpenAI';
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

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
                model: 'gpt-4o',
                messages: [
                    { role: 'system', content: 'You are a security engineer. Respond only in valid JSON.' },
                    { role: 'user', content: prompt },
                ],
                max_tokens: 4096,
                response_format: { type: 'json_object' },
            }),
        });

        if (!response.ok) {
            throw new Error(`OpenAI API error: ${response.status} ${await response.text()}`);
        }

        const data = await response.json() as { choices?: { message?: { content?: string } }[] };
        const text = data.choices?.[0]?.message?.content || '';
        return parseFixResponse(text, params.finding, params.filePath);
    }
}
