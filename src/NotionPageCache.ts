import * as fs from "fs-extra";
import * as path from "path";
import { verbose, logDebug } from "./log";

interface PageInfo {
  lastEditedTime: string;
}

interface CacheData {
  [pageId: string]: PageInfo;
}

export class NotionPageCache {
  private cache: CacheData = {};
  private cachePath: string;

  constructor(outputDir: string) {
    // Normalize the path to handle cases like ".\blog" -> "blog"
    const normalizedOutputDir = path.normalize(outputDir).replace(/^\.[\\/]/, '');
    this.cachePath = path.join(normalizedOutputDir, ".docu-notion-cache.json");
    this.load();
  }

  private load(): void {
    if (fs.existsSync(this.cachePath)) {
      try {
        this.cache = fs.readJsonSync(this.cachePath);
        verbose(`Loaded ${Object.keys(this.cache).length} pages from cache.`);
      } catch (e) {
        logDebug("Error loading page cache.", (e as Error).message);
        // ignore, we'll just start a new cache
      }
    }
  }

  public save(): void {
    try {
      fs.writeJsonSync(this.cachePath, this.cache, { spaces: 2 });
    } catch (e) {
      logDebug("Error saving page cache.", (e as Error).message);
    }
  }

  public isPageInCacheAndUpToDate(
    pageId: string,
    lastEditedTime: string
  ): boolean {
    const info = this.cache[pageId];
    if (!info) {
      return false; // not in cache
    }
    // The notion api gives us a date that is a string.
    // We can do a string comparison because the format is ISO 8601.
    return lastEditedTime <= info.lastEditedTime;
  }

  public addPage(pageId: string, lastEditedTime: string): void {
    this.cache[pageId] = { lastEditedTime };
  }
}
