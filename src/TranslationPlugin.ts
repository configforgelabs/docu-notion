import * as path from 'path';
import * as fs from 'fs-extra';
import { TranslationService, TranslationOptions, TranslationResult } from './TranslationService';
import { DocuNotionOptions } from './pull';
import { info, error, warning } from './log';

export interface TranslationPluginOptions {
  enabled: boolean;
  provider: 'openai' | 'anthropic';
  apiKey: string;
  model?: string;
  sourceLanguage: string;
  targetLanguages: string[];
  preserveCodeBlocks: boolean;
  preserveFrontmatter: boolean;
  preserveLinks: boolean;
  outputDir?: string; // Custom output directory, defaults to i18n/{locale}/docusaurus-plugin-content-docs/current/
}

export class TranslationPlugin {
  private options: TranslationPluginOptions;
  private docuNotionOptions: DocuNotionOptions;

  constructor(options: TranslationPluginOptions, docuNotionOptions: DocuNotionOptions) {
    this.options = options;
    this.docuNotionOptions = docuNotionOptions;
  }

  /**
   * Main translation workflow - translate all generated markdown files
   */
  async translateGeneratedContent(): Promise<void> {
    if (!this.options.enabled) {
      info('Translation plugin is disabled, skipping translation');
      return;
    }

    if (!this.options.apiKey) {
      warning('Translation API key not provided, skipping translation');
      return;
    }

    if (this.options.targetLanguages.length === 0) {
      warning('No target languages specified, skipping translation');
      return;
    }

    info(`Starting translation from ${this.options.sourceLanguage} to: ${this.options.targetLanguages.join(', ')}`);

    const sourceDir = this.docuNotionOptions.markdownOutputPath;
    
    if (!await fs.pathExists(sourceDir)) {
      error(`Source directory does not exist: ${sourceDir}`);
      return;
    }

    // Translate to each target language
    for (const targetLanguage of this.options.targetLanguages) {
      await this.translateToLanguage(sourceDir, targetLanguage);
    }

    info('Translation process completed');
  }

  /**
   * Translate all content to a specific target language
   */
  private async translateToLanguage(sourceDir: string, targetLanguage: string): Promise<void> {
    try {
      info(`Translating to ${targetLanguage}...`);

      const translationOptions: TranslationOptions = {
        provider: this.options.provider,
        apiKey: this.options.apiKey,
        model: this.options.model,
        sourceLanguage: this.options.sourceLanguage,
        targetLanguage: targetLanguage,
        preserveCodeBlocks: this.options.preserveCodeBlocks,
        preserveFrontmatter: this.options.preserveFrontmatter,
        preserveLinks: this.options.preserveLinks,
      };

      const translationService = new TranslationService(translationOptions);
      
      // Determine target directory
      const targetDir = this.getTargetDirectory(targetLanguage);
      
      // Ensure target directory exists
      await fs.ensureDir(targetDir);
      
      // Translate all markdown files
      const results = await translationService.translateDirectory(sourceDir, targetDir, true);
      
      // Report results
      this.reportTranslationResults(results, targetLanguage);
      
    } catch (err) {
      error(`Translation to ${targetLanguage} failed: ${err}`);
    }
  }

  /**
   * Get the target directory for a specific language following Docusaurus i18n conventions
   */
  private getTargetDirectory(targetLanguage: string): string {
    if (this.options.outputDir) {
      return path.join(this.options.outputDir, targetLanguage);
    }

    // Default Docusaurus i18n structure
    const workspaceRoot = path.dirname(this.docuNotionOptions.markdownOutputPath);
    return path.join(workspaceRoot, 'i18n', targetLanguage, 'docusaurus-plugin-content-docs', 'current');
  }

  /**
   * Report translation results and statistics
   */
  private reportTranslationResults(results: TranslationResult[], targetLanguage: string): void {
    const successCount = results.filter(r => r.success).length;
    const failureCount = results.filter(r => !r.success).length;
    const totalTokens = results.reduce((sum, r) => sum + (r.tokensUsed || 0), 0);

    info(`Translation to ${targetLanguage} completed:`);
    info(`  ✅ Successful: ${successCount} files`);
    
    if (failureCount > 0) {
      warning(`  ❌ Failed: ${failureCount} files`);
      
      // Log first few failures for debugging
      const failures = results.filter(r => !r.success).slice(0, 3);
      for (const failure of failures) {
        error(`    Error: ${failure.error}`);
      }
    }

    if (totalTokens > 0) {
      info(`  🪙 Total tokens used: ${totalTokens.toLocaleString()}`);
      
      // Estimate cost if possible
      if (results.length > 0 && results[0].tokensUsed) {
        const translationService = new TranslationService({
          provider: this.options.provider,
          apiKey: this.options.apiKey,
          sourceLanguage: this.options.sourceLanguage,
          targetLanguage: targetLanguage,
          preserveCodeBlocks: this.options.preserveCodeBlocks,
          preserveFrontmatter: this.options.preserveFrontmatter,
          preserveLinks: this.options.preserveLinks,
        });
        
        const estimatedCost = translationService.getEstimatedCost(totalTokens);
        if (estimatedCost > 0) {
          info(`  💰 Estimated cost: $${estimatedCost.toFixed(3)}`);
        }
      }
    }
  }

  /**
   * Validate translation plugin configuration
   */
  static validateOptions(options: TranslationPluginOptions): string[] {
    const errors: string[] = [];

    if (!options.enabled) {
      return errors; // Skip validation if disabled
    }

    if (!options.provider || !['openai', 'anthropic'].includes(options.provider)) {
      errors.push('Translation provider must be either "openai" or "anthropic"');
    }

    if (!options.apiKey || options.apiKey.trim() === '') {
      errors.push('Translation API key is required');
    }

    if (!options.sourceLanguage || options.sourceLanguage.trim() === '') {
      errors.push('Source language is required');
    }

    if (!options.targetLanguages || options.targetLanguages.length === 0) {
      errors.push('At least one target language is required');
    }

    if (options.targetLanguages && options.targetLanguages.includes(options.sourceLanguage)) {
      errors.push('Target languages cannot include the source language');
    }

    return errors;
  }

  /**
   * Create default translation options
   */
  static createDefaultOptions(): Partial<TranslationPluginOptions> {
    return {
      enabled: false,
      provider: 'openai',
      sourceLanguage: 'English',
      targetLanguages: [],
      preserveCodeBlocks: true,
      preserveFrontmatter: true,
      preserveLinks: true,
    };
  }

  /**
   * Check if the plugin is properly configured and ready to run
   */
  isReady(): boolean {
    const errors = TranslationPlugin.validateOptions(this.options);
    return errors.length === 0;
  }

  /**
   * Get configuration validation errors
   */
  getConfigurationErrors(): string[] {
    return TranslationPlugin.validateOptions(this.options);
  }
}
