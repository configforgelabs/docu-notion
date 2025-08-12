import * as fs from "fs-extra";
import * as Path from "path";
import * as crypto from "crypto";
import FileType, { FileTypeResult } from "file-type";
import { makeImagePersistencePlan } from "./MakeImagePersistencePlan";
import { logDebug, verbose } from "./log";
import { ListBlockChildrenResponseResult } from "notion-to-md/build/types";
import {
  IDocuNotionContext,
  IDocuNotionContextPageInfo,
  IPlugin,
} from "./plugins/pluginTypes";
import { writeAsset } from "./assets";

// We handle several things here:
// 1) copy images locally instead of leaving them in Notion
// 2) change the links to point here
// 3) read the caption and if there are localized images, get those too
// 4) prepare for localized documents, which need a copy of every image

let existingImagesNotSeenYetInPull: string[] = [];
let imageOutputPath = ""; // default to putting in the same directory as the document referring to it.
let imagePrefix = ""; // default to "./"
let locales: string[];

// we parse a notion image and its caption into what we need, which includes any urls to localized versions
// of the image that may be embedded in the caption.
export type ImageSet = {
  // We get these from parseImageBlock():
  primaryUrl: string;
  // caption may contain a caption and/or URLs to localized versions
  caption?: string;
  // We use entries in localizedUrls whether or not we have a url, because if we don't have
  // a localized image, we then need to copy the primary image in, instead, to
  // get image fallback. In that case, the placeholder at least tells us what languages
  // are being supported.
  localizedUrls: Array<{ iso632Code: string; url: string }>;

  // then we fill this in from processImageBlock():
  pageInfo?: IDocuNotionContextPageInfo;

  // then we fill these in readPrimaryImage():
  primaryBuffer?: Buffer;
  fileType?: FileTypeResult;

  // then we fill these in from makeImagePersistencePlan():
  primaryFileOutputPath?: string;
  outputFileName?: string;
  filePathToUseInMarkdown?: string;
};

export async function initImageHandling(
  prefix: string,
  outputPath: string,
  incomingLocales: string[]
): Promise<void> {
  // If they gave us a trailing slash, remove it because we add it back later.
  // Note that it's up to the caller to have a *leading* slash or not.
  imagePrefix = prefix.replace(/\/$/, "");
  imageOutputPath = outputPath;
  locales = incomingLocales;

  // Currently we don't delete the image directory, because if an image
  // changes, it gets a new id. This way can then prevent downloading
  // and image after the 1st time. The downside is currently we don't
  // have the smarts to remove unused images.
  if (imageOutputPath) {
    await fs.mkdir(imageOutputPath, { recursive: true });
  }
}

export const standardImageTransformer: IPlugin = {
  name: "DownloadImagesToRepo",
  notionToMarkdownTransforms: [
    {
      type: "image",
      // we have to set this one up for each page because we need to
      // give it two extra parameters that are context for each page
      getStringFromBlock: (
        context: IDocuNotionContext,
        block: ListBlockChildrenResponseResult
      ) => markdownToMDImageTransformer(block, context),
    },
  ],
};

// This is a "custom transformer" function passed to notion-to-markdown
// eslint-disable-next-line @typescript-eslint/require-await
export async function markdownToMDImageTransformer(
  block: ListBlockChildrenResponseResult,
  context: IDocuNotionContext
): Promise<string> {
  const image = (block as any).image;

  await processImageBlock(block, context);

  // just concatenate the caption text parts together
  const altText: string = image.caption
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    .map((item: any) => item.plain_text)
    .join("");

  const href: string =
    image.type === "external" ? image.external.url : image.file.url;
  return `![${altText}](${href})`;
}

async function processImageBlock(
  block: any,
  context: IDocuNotionContext
): Promise<void> {
  const imageBlock = block.image;
  logDebug("processImageBlock", JSON.stringify(imageBlock));

  const imageSet = parseImageBlock(imageBlock);
  imageSet.pageInfo = context.pageInfo;

  // First, try to determine the filename without downloading
  const canDetermineFilenameEarly = context.options.imageFileNameFormat !== "content-hash";
  
  if (canDetermineFilenameEarly) {
    // For "default" and "legacy" modes, we can determine filename from URL/block ID
    makeImagePersistencePlanWithoutBuffer(
      context.options,
      imageSet,
      block.id,
      imageOutputPath,
      imagePrefix
    );
    
    // Check if the primary image already exists
    if (!context.options.forceRefreshImages && imageSet.primaryFileOutputPath && fs.existsSync(imageSet.primaryFileOutputPath)) {
      verbose(`Primary image already exists, skipping download: ${imageSet.primaryFileOutputPath}`);
      imageWasSeen(imageSet.primaryFileOutputPath);
      // We still need to process localized images, but can skip primary download
      await saveLocalizedImages(imageSet, context);
    } else {
      // Download and save as usual
      await readPrimaryImage(imageSet);
      await saveImage(imageSet, context);
    }
  } else {
    // For "content-hash" mode, we need to download first to generate hash-based filename
    await readPrimaryImage(imageSet);
    makeImagePersistencePlan(
      context.options,
      imageSet,
      block.id,
      imageOutputPath,
      imagePrefix
    );
    await saveImage(imageSet, context);
  }

  // change the src to point to our copy of the image
  if ("file" in imageBlock) {
    imageBlock.file.url = imageSet.filePathToUseInMarkdown;
  } else {
    imageBlock.external.url = imageSet.filePathToUseInMarkdown;
  }
  // put back the simplified caption, stripped of the meta information
  if (imageSet.caption) {
    imageBlock.caption = [
      {
        type: "text",
        text: { content: imageSet.caption, link: null },
        plain_text: imageSet.caption,
      },
    ];
  } else {
    imageBlock.caption = [];
  }
}

async function readPrimaryImage(imageSet: ImageSet) {
  // In Mar 2024, we started having a problem getting a particular gif from imgur using
  // node-fetch. Switching to axios resolved it. I don't know why.
  // Then, in Apr 2025, we started getting 429 responses from imgur through axios,
  // so we switched to node's built-in fetch (different than the node-fetch package).
  // Just a guess, but probably imgur keeps locking down what it suspects as code running
  // to scrape images.
  // Apparently, imgur is getting to be more and more of a liability,
  // so we should probably stop using it.
  const response = await fetch(imageSet.primaryUrl);
  const arrayBuffer = await response.arrayBuffer();
  imageSet.primaryBuffer = Buffer.from(arrayBuffer);
  imageSet.fileType = await FileType.fromBuffer(imageSet.primaryBuffer);
}

// Create a lightweight version of makeImagePersistencePlan that doesn't need the buffer
function makeImagePersistencePlanWithoutBuffer(
  options: any,
  imageSet: ImageSet,
  imageBlockId: string,
  imageOutputRootPath: string,
  imagePrefix: string
): void {
  const urlBeforeQuery = imageSet.primaryUrl.split("?")[0];
  
  // Try to get the extension from the url first
  let imageFileExtension = urlBeforeQuery.split(".").pop();
  
  if (!imageFileExtension) {
    // Fallback to common image extensions if we can't determine from URL
    imageFileExtension = "png"; // Most screenshots are PNG
  }

  if (options.imageFileNameFormat === "legacy") {
    // Same logic as in MakeImagePersistencePlan.ts
    const thingToHash = findLastUuid(urlBeforeQuery) ?? urlBeforeQuery;
    const hash = hashOfString(thingToHash);
    imageSet.outputFileName = `${hash}.${imageFileExtension}`;
  } else {
    // Default format: page slug + block ID
    const pageSlugPart = imageSet.pageInfo?.slug
      ? `${imageSet.pageInfo.slug.replace(/^\//, "")}.`
      : "";
    imageSet.outputFileName = `${pageSlugPart}${imageBlockId}.${imageFileExtension}`;
  }

  imageSet.primaryFileOutputPath = Path.posix.join(
    imageOutputRootPath?.length > 0
      ? imageOutputRootPath
      : imageSet.pageInfo!.directoryContainingMarkdown,
    decodeURI(imageSet.outputFileName)
  );

  imageSet.filePathToUseInMarkdown =
    (imagePrefix?.length > 0 ? imagePrefix : ".") +
    "/" +
    imageSet.outputFileName;
}

// Helper function to handle only localized images
async function saveLocalizedImages(imageSet: ImageSet, context: IDocuNotionContext): Promise<void> {
  for (const localizedImage of imageSet.localizedUrls) {
    const directory = `./i18n/${
      localizedImage.iso632Code
    }/docusaurus-plugin-content-docs/current/${
      imageSet.pageInfo!.relativeFilePathToFolderContainingPage
    }`;

    const newPath = (directory + "/" + imageSet.outputFileName!).replaceAll(
      "//",
      "/"
    );

    // Always mark the image as seen for cleanup purposes
    imageWasSeen(newPath);

    // Check if localized image already exists before downloading/saving
    if (!context.options.forceRefreshImages && fs.existsSync(newPath)) {
      verbose(`Localized (${localizedImage.iso632Code}) image already exists, skipping: ${newPath}`);
    } else {
      let buffer = imageSet.primaryBuffer!;
      
      // if we have a url for the localized screenshot, download it
      if (localizedImage?.url.length > 0) {
        verbose(`Retrieving ${localizedImage.iso632Code} version...`);
        const response = await fetch(localizedImage.url);
        const arrayBuffer = await response.arrayBuffer();
        buffer = Buffer.from(arrayBuffer);
      } else {
        verbose(
          `No localized image specified for ${localizedImage.iso632Code}, will use primary image.`
        );
        // For fallback to primary image, we need the primary buffer
        // If we don't have it yet (because we skipped download), we need to download it
        if (!imageSet.primaryBuffer) {
          await readPrimaryImage(imageSet);
        }
        buffer = imageSet.primaryBuffer!;
      }

      writeAsset(newPath, buffer);
      verbose(`Saved localized (${localizedImage.iso632Code}) image: ${newPath}`);
    }
  }
}

// Helper functions from MakeImagePersistencePlan.ts
function findLastUuid(url: string): string | null {
  const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const matches = url.match(uuidRegex);
  return matches ? matches[matches.length - 1] : null;
}

function hashOfString(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").substring(0, 8);
}

async function saveImage(imageSet: ImageSet, context: IDocuNotionContext): Promise<void> {
  // Save primary image
  const primaryPath = imageSet.primaryFileOutputPath!;
  imageWasSeen(primaryPath); // Always mark as seen for cleanup purposes
  
  if (!context.options.forceRefreshImages && fs.existsSync(primaryPath)) {
    verbose(`Primary image already exists, skipping: ${primaryPath}`);
  } else {
    writeAsset(primaryPath, imageSet.primaryBuffer!);
    verbose(`Saved primary image: ${primaryPath}`);
  }

  // Save localized images
  await saveLocalizedImages(imageSet, context);
}

export function parseImageBlock(image: any): ImageSet {
  if (!locales) throw Error("Did you call initImageHandling()?");
  const imageSet: ImageSet = {
    primaryUrl: "",
    caption: "",
    localizedUrls: locales.map(l => ({ iso632Code: l, url: "" })),
  };

  if ("file" in image) {
    imageSet.primaryUrl = image.file.url; // image saved on notion (actually AWS)
  } else {
    imageSet.primaryUrl = image.external.url; // image still pointing somewhere else. I've see this happen when copying a Google Doc into Notion. Notion kep pointing at the google doc.
  }

  const mergedCaption: string = image.caption
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    .map((c: any) => c.plain_text)
    .join("");
  const lines = mergedCaption.split("\n");

  // Example:
  // Caption before images.\nfr https://i.imgur.com/pYmE7OJ.png\nES  https://i.imgur.com/8paSZ0i.png\nCaption after images

  lines.forEach(l => {
    const match = /\s*(..)\s*(https:\/\/.*)/.exec(l);
    if (match) {
      imageSet.localizedUrls.push({
        iso632Code: match[1].toLowerCase(),
        url: match[2],
      });
    } else {
      // NB: carriage returns seem to mess up the markdown, so should be removed
      imageSet.caption += l + " ";
    }
  });
  // NB: currently notion-md puts the caption in Alt, which noone sees (unless the image isn't found)
  // We could inject a custom element handler to emit a <figure> in order to show the caption.
  imageSet.caption = imageSet.caption?.trim();
  //console.log(JSON.stringify(imageSet, null, 2));

  return imageSet;
}

function imageWasSeen(path: string) {
  existingImagesNotSeenYetInPull = existingImagesNotSeenYetInPull.filter(
    p => p !== path
  );
}

export async function cleanupOldImages(): Promise<void> {
  for (const p of existingImagesNotSeenYetInPull) {
    verbose(`Removing old image: ${p}`);
    await fs.rm(p);
  }
}