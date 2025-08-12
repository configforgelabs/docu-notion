import { NotionToMarkdown } from "notion-to-md";
import { NotionBlock } from "../types";
import { IPlugin } from "./pluginTypes";
import { logDebug } from "../log";

// Makes links to headings work in docusaurus and shifts heading levels down by one
// H1 becomes H2, H2 becomes H3, etc. This allows using frontmatter title instead of H1 in content
// https://github.com/sillsdev/docu-notion/issues/20
async function headingTransformerWithLevelShift(
  notionToMarkdown: NotionToMarkdown,
  block: NotionBlock,
  targetLevel: number
): Promise<string> {
  // Create a copy of the block and modify its type and properties to the target level
  const modifiedBlock = { ...block };
  const originalLevel = parseInt(block.type.replace('DN_heading_', ''));
  
  // Set the new type
  (modifiedBlock as any).type = `heading_${targetLevel}`;
  
  // Copy the heading data from the original level to the target level
  const headingKey = `heading_${originalLevel}` as keyof typeof block;
  const targetHeadingKey = `heading_${targetLevel}`;
  
  if (block[headingKey]) {
    (modifiedBlock as any)[targetHeadingKey] = block[headingKey];
    // Remove the old heading property to avoid conflicts
    delete (modifiedBlock as any)[headingKey];
  }

  const markdown = await notionToMarkdown.blockToMarkdown(modifiedBlock);

  logDebug(
    "headingTransformerWithLevelShift, markdown of a heading before adding id",
    markdown
  );

  // To make heading links work in docusaurus, we append an id. E.g.
  //  ### Hello World {#my-explicit-id}
  // See https://docusaurus.io/docs/markdown-features/toc#heading-ids.

  // For some reason, inline links come in without the dashes, so we have to strip
  // dashes here to match them.
  //console.log("block.id", block.id)
  const blockIdWithoutDashes = block.id.replaceAll("-", "");

  // Finally, append the block id so that it can be the target of a link.
  return `${markdown} {#${blockIdWithoutDashes}}`;
}

export const standardHeadingTransformer: IPlugin = {
  name: "standardHeadingTransformer",

  // AP wrote: We have to do this because if
  // we simply set a custom transformer to heading_n, it will keep
  // recursively calling this code, with blockToMarkdown using the custom transformer
  // over and over. Instead, we want blockToMarkdown to give us the normal
  // result, to which we will append the block ID to enable heading links.
  notionBlockModifications: [
    {
      modify: (block: NotionBlock) => {
        // "as any" needed because we're putting a value in that is not allowed by the real type
        (block as any).type = block.type.replace("heading", "DN_heading");
      },
    },
  ],
  // Add support for heading level 4 that notion-to-md doesn't support by default
  // Only H1-H3 from Notion are supported, which become H2-H4 in the output
  notionToMarkdownTransforms: [
    // First, register the missing heading_4 transformer that notion-to-md doesn't have
    {
      type: "heading_4",
      getStringFromBlock: async (context, block) => {
        const headingData = (block as any).heading_4;
        const text = headingData?.rich_text?.map((t: any) => t.plain_text).join('') || '';
        return `#### ${text}`;
      },
    },
    // Now register our custom transformers that shift heading levels down by one
    // Notion H1 -> Markdown H2, Notion H2 -> Markdown H3, Notion H3 -> Markdown H4
    {
      type: "DN_heading_1",
      getStringFromBlock: (context, block) =>
        headingTransformerWithLevelShift(context.notionToMarkdown, block, 2), // H1 becomes H2
    },
    {
      type: "DN_heading_2",
      getStringFromBlock: (context, block) =>
        headingTransformerWithLevelShift(context.notionToMarkdown, block, 3), // H2 becomes H3
    },
    {
      type: "DN_heading_3",
      getStringFromBlock: (context, block) =>
        headingTransformerWithLevelShift(context.notionToMarkdown, block, 4), // H3 becomes H4
    },
  ],
};
