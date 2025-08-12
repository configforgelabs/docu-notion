import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TranslationService, TranslationOptions } from './TranslationService';
import { TranslationPlugin, TranslationPluginOptions } from './TranslationPlugin';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs-extra';

// Mock the API clients
vi.mock('openai', () => {
  const mockOpenAIClass = vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: 'Übersetzter Text' } }],
          usage: { total_tokens: 100 }
        })
      }
    }
  }));
  
  return {
    default: mockOpenAIClass,
    OpenAI: mockOpenAIClass
  };
});

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Übersetzter Text' }],
        usage: { input_tokens: 50, output_tokens: 50 }
      })
    }
  }))
}));

vi.mock('fs-extra', () => ({
  readdir: vi.fn(),
  pathExists: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  ensureDir: vi.fn()
}));

describe('TranslationService', () => {
  const mockOptions: TranslationOptions = {
    provider: 'openai',
    apiKey: 'test-key',
    sourceLanguage: 'English',
    targetLanguage: 'German',
    preserveCodeBlocks: true,
    preserveFrontmatter: true,
    preserveLinks: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create TranslationService with OpenAI provider', () => {
    const service = new TranslationService(mockOptions);
    expect(service).toBeDefined();
  });

  it('should create TranslationService with Anthropic provider', () => {
    const anthropicOptions: TranslationOptions = {
      ...mockOptions,
      provider: 'anthropic'
    };
    const service = new TranslationService(anthropicOptions);
    expect(service).toBeDefined();
  });

  it('should translate markdown content successfully', async () => {
    const service = new TranslationService(mockOptions);
    const content = '# Hello World\\n\\nThis is a test document.';
    
    const result = await service.translateMarkdown(content, 'test.md');
    
    expect(result.success).toBe(true);
    expect(result.translatedContent).toBe('Übersetzter Text');
    expect(result.tokensUsed).toBe(100);
  });

  it('should handle translation errors gracefully', async () => {
    const options: TranslationOptions = {
      provider: 'invalid-provider' as any, // This will trigger the error path
      apiKey: 'test-key',
      sourceLanguage: 'English',
      targetLanguage: 'German',
      preserveCodeBlocks: true,
      preserveFrontmatter: true,
      preserveLinks: true
    };
    
    const service = new TranslationService(options);
    
    const result = await service.translateMarkdown('# Test', 'test.md');
    expect(result.success).toBe(false);
    expect(result.translatedContent).toBe('# Test'); // Should return original content on error
    expect(result.error).toBe('Unsupported translation provider: invalid-provider');
  });

  it('should estimate costs correctly', () => {
    const service = new TranslationService(mockOptions);
    
    const cost = service.getEstimatedCost(1000);
    expect(cost).toBe(0.03); // $0.03 per 1K tokens for OpenAI
  });
});

describe('TranslationPlugin', () => {
  const mockTranslationOptions: TranslationPluginOptions = {
    enabled: true,
    provider: 'openai',
    apiKey: 'test-key',
    sourceLanguage: 'English',
    targetLanguages: ['German', 'French'],
    preserveCodeBlocks: true,
    preserveFrontmatter: true,
    preserveLinks: true,
  };

  const mockDocuNotionOptions = {
    notionToken: 'test-token',
    rootPage: 'test-root',
    locales: ['de', 'fr'],
    markdownOutputPath: '/test/docs',
    imgOutputPath: '/test/images',
    imgPrefixInMarkdown: '/images',
    statusTag: 'Publish',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should validate configuration correctly', () => {
    const errors = TranslationPlugin.validateOptions(mockTranslationOptions);
    expect(errors).toHaveLength(0);
  });

  it('should detect configuration errors', () => {
    const invalidOptions: TranslationPluginOptions = {
      ...mockTranslationOptions,
      provider: 'invalid' as any,
      apiKey: '',
      targetLanguages: [],
    };

    const errors = TranslationPlugin.validateOptions(invalidOptions);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors).toContain('Translation provider must be either "openai" or "anthropic"');
    expect(errors).toContain('Translation API key is required');
    expect(errors).toContain('At least one target language is required');
  });

  it('should create default options', () => {
    const defaults = TranslationPlugin.createDefaultOptions();
    
    expect(defaults.enabled).toBe(false);
    expect(defaults.provider).toBe('openai');
    expect(defaults.preserveCodeBlocks).toBe(true);
    expect(defaults.preserveFrontmatter).toBe(true);
    expect(defaults.preserveLinks).toBe(true);
  });

  it('should skip translation when disabled', async () => {
    const disabledOptions: TranslationPluginOptions = {
      ...mockTranslationOptions,
      enabled: false,
    };

    const plugin = new TranslationPlugin(disabledOptions, mockDocuNotionOptions);
    
    // Mock fs.pathExists to return true
    vi.mocked(fs.pathExists).mockResolvedValue(true as any);
    
    await plugin.translateGeneratedContent();
    
    // Should not attempt to read the directory if translation is disabled
    expect(vi.mocked(fs.readdir)).not.toHaveBeenCalled();
  });

  it('should handle missing API key gracefully', async () => {
    const noKeyOptions: TranslationPluginOptions = {
      ...mockTranslationOptions,
      apiKey: '',
    };

    const plugin = new TranslationPlugin(noKeyOptions, mockDocuNotionOptions);
    
    // Mock fs.pathExists to return true
    vi.mocked(fs.pathExists).mockResolvedValue(true as any);
    
    await plugin.translateGeneratedContent();
    
    // Should not attempt to read the directory if no API key
    expect(vi.mocked(fs.readdir)).not.toHaveBeenCalled();
  });

  it('should generate correct target directory path', () => {
    const plugin = new TranslationPlugin(mockTranslationOptions, mockDocuNotionOptions);
    
    // Access the private method through type assertion for testing
    const targetDir = (plugin as any).getTargetDirectory('de');
    
    expect(targetDir).toBe('/test/i18n/de/docusaurus-plugin-content-docs/current');
  });
});

describe('TranslationService prompt building', () => {
  it('should build appropriate translation prompts', async () => {
    const service = new TranslationService({
      provider: 'openai',
      apiKey: 'test-key',
      sourceLanguage: 'English',
      targetLanguage: 'German',
      preserveCodeBlocks: true,
      preserveFrontmatter: true,
      preserveLinks: true,
    });

    // Test that the prompt building doesn't throw errors
    const content = `---
title: Test Page
---

# Hello World

This is a test with \`inline code\` and:

\`\`\`bash
npm install test
\`\`\`

And a [link](https://example.com).
`;

    const result = await service.translateMarkdown(content, 'test.md');
    expect(result).toBeDefined();
  });
});
