import { OpenAI } from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { info, error } from './log';
import * as fs from 'fs-extra';
import * as path from 'path';

export interface TranslationOptions {
  provider: 'openai' | 'anthropic';
  apiKey: string;
  model?: string;
  sourceLanguage: string;
  targetLanguage: string;
  preserveCodeBlocks: boolean;
  preserveFrontmatter: boolean;
  preserveLinks: boolean;
}

export interface TranslationResult {
  translatedContent: string;
  success: boolean;
  error?: string;
  tokensUsed?: number;
}

export class TranslationService {
  private openaiClient?: OpenAI;
  private anthropicClient?: Anthropic;
  private options: TranslationOptions;

  constructor(options: TranslationOptions) {
    this.options = options;
    
    if (options.provider === 'openai') {
      this.openaiClient = new OpenAI({
        apiKey: options.apiKey,
      });
    } else if (options.provider === 'anthropic') {
      this.anthropicClient = new Anthropic({
        apiKey: options.apiKey,
      });
    }
  }

  /**
   * Translate markdown content from source language to target language
   */
  async translateMarkdown(content: string, filename: string): Promise<TranslationResult> {
    try {
      info(`Translating ${filename} from ${this.options.sourceLanguage} to ${this.options.targetLanguage}`);

      const prompt = this.buildTranslationPrompt(content);
      
      if (this.options.provider === 'openai') {
        return await this.translateWithOpenAI(prompt);
      } else if (this.options.provider === 'anthropic') {
        return await this.translateWithAnthropic(prompt);
      } else {
        throw new Error(`Unsupported translation provider: ${this.options.provider}`);
      }
    } catch (err) {
      error(`Translation failed for ${filename}: ${err}`);
      return {
        translatedContent: content,
        success: false,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  /**
   * Translate a single file and save it to the target directory
   */
  async translateFile(sourcePath: string, targetPath: string): Promise<TranslationResult> {
    try {
      const content = await fs.readFile(sourcePath, 'utf-8');
      const filename = path.basename(sourcePath);
      
      const result = await this.translateMarkdown(content, filename);
      
      if (result.success) {
        await fs.ensureDir(path.dirname(targetPath));
        await fs.writeFile(targetPath, result.translatedContent, 'utf-8');
        info(`Translated file saved: ${targetPath}`);
      }
      
      return result;
    } catch (err) {
      error(`File translation failed: ${err}`);
      return {
        translatedContent: '',
        success: false,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  /**
   * Translate all markdown files in a directory
   */
  async translateDirectory(sourceDir: string, targetDir: string, recursive: boolean = true): Promise<TranslationResult[]> {
    const results: TranslationResult[] = [];
    
    try {
      const items = await fs.readdir(sourceDir, { withFileTypes: true });
      
      for (const item of items) {
        const sourcePath = path.join(sourceDir, item.name);
        const targetPath = path.join(targetDir, item.name);
        
        if (item.isDirectory() && recursive) {
          // Recursively translate subdirectories
          const subResults = await this.translateDirectory(sourcePath, targetPath, recursive);
          results.push(...subResults);
        } else if (item.isFile() && (item.name.endsWith('.md') || item.name.endsWith('.mdx'))) {
          // Translate markdown files
          const result = await this.translateFile(sourcePath, targetPath);
          results.push(result);
        } else if (item.isFile()) {
          // Copy non-markdown files as-is
          await fs.ensureDir(path.dirname(targetPath));
          await fs.copy(sourcePath, targetPath);
          info(`Copied non-markdown file: ${targetPath}`);
        }
      }
    } catch (err) {
      error(`Directory translation failed: ${err}`);
      results.push({
        translatedContent: '',
        success: false,
        error: err instanceof Error ? err.message : String(err)
      });
    }
    
    return results;
  }

  private buildTranslationPrompt(content: string): string {
    const preservationInstructions = [];
    
    if (this.options.preserveCodeBlocks) {
      preservationInstructions.push('- Preserve all code blocks exactly as they are (do not translate code, comments in code, or technical syntax)');
    }
    
    if (this.options.preserveFrontmatter) {
      preservationInstructions.push('- Preserve YAML frontmatter exactly as it is (do not translate metadata keys or technical values)');
    }
    
    if (this.options.preserveLinks) {
      preservationInstructions.push('- Preserve all markdown links and URLs exactly as they are (do not translate link URLs or anchor IDs)');
    }

    const prompt = `You are a professional translator specializing in technical documentation. Translate the following markdown content from ${this.options.sourceLanguage} to ${this.options.targetLanguage}.

CRITICAL PRESERVATION RULES:
${preservationInstructions.join('\n')}
- Preserve all markdown formatting (headers, lists, tables, etc.)
- Preserve HTML tags and attributes exactly as they are
- Preserve file paths, URLs, and technical identifiers
- Only translate natural language text content
- Maintain the exact same document structure

TRANSLATION GUIDELINES:
- Use natural, fluent ${this.options.targetLanguage}
- Adapt technical terms appropriately for ${this.options.targetLanguage} readers
- Maintain consistent terminology throughout
- Preserve the original tone and style

INPUT CONTENT:
---
${content}
---

Please provide only the translated content without any additional commentary or explanations.`;

    return prompt;
  }

  private async translateWithOpenAI(prompt: string): Promise<TranslationResult> {
    if (!this.openaiClient) {
      throw new Error('OpenAI client not initialized');
    }

    const model = this.options.model || 'gpt-4';
    
    const completion = await this.openaiClient.chat.completions.create({
      model: model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3, // Lower temperature for more consistent translations
    });

    const translatedContent = completion.choices[0]?.message?.content;
    
    if (!translatedContent) {
      throw new Error('No translation received from OpenAI');
    }

    return {
      translatedContent,
      success: true,
      tokensUsed: completion.usage?.total_tokens
    };
  }

  private async translateWithAnthropic(prompt: string): Promise<TranslationResult> {
    if (!this.anthropicClient) {
      throw new Error('Anthropic client not initialized');
    }

    const model = this.options.model || 'claude-3-sonnet-20240229';
    
    const message = await this.anthropicClient.messages.create({
      model: model,
      max_tokens: 4000,
      temperature: 0.3,
      messages: [{ role: 'user', content: prompt }]
    });

    const translatedContent = message.content[0]?.type === 'text' ? message.content[0].text : '';
    
    if (!translatedContent) {
      throw new Error('No translation received from Anthropic');
    }

    return {
      translatedContent,
      success: true,
      tokensUsed: message.usage.input_tokens + message.usage.output_tokens
    };
  }

  /**
   * Get estimated cost for translation (approximate)
   */
  getEstimatedCost(tokenCount: number): number {
    if (this.options.provider === 'openai') {
      // GPT-4 pricing (approximate, check current rates)
      return (tokenCount / 1000) * 0.03; // $0.03 per 1K tokens
    } else if (this.options.provider === 'anthropic') {
      // Claude pricing (approximate, check current rates)
      return (tokenCount / 1000) * 0.015; // $0.015 per 1K tokens
    }
    return 0;
  }
}
