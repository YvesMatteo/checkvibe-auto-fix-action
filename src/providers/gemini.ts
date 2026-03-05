import type { AIProvider, Finding, FixResult } from './types';
import { buildPrompt, parseFixResponse } from './prompt';

export class GeminiProvider implements AIProvider {
    name = 'Gemini (Google)';
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

        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        responseMimeType: 'application/json',
                        maxOutputTokens: 4096,
                    },
                }),
            }
        );

        if (!response.ok) {
            throw new Error(`Gemini API error: ${response.status} ${await response.text()}`);
        }

        const data = await response.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        return parseFixResponse(text, params.finding, params.filePath);
    }
}
