import { NotionBlock } from "../types";
import { IPlugin } from "./pluginTypes";
import { verbose } from "../log";

// Define a new, virtual block type to represent a group of list items.
// The 'as any' is a necessary evil here because this is a type we've made up.
const LIST_ITEM_GROUP_TYPE = "list_item_group" as any;

// This is the main optimization function that will be called from transform.ts.
// It takes an array of blocks and returns a new array with list items grouped together.
export function optimizeListProcessing(blocks: NotionBlock[]): NotionBlock[] {
  // If there are fewer than this many blocks, it's not worth the overhead to optimize.
  const MIN_BLOCKS_TO_OPTIMIZE = 10;
  if (blocks.length < MIN_BLOCKS_TO_OPTIMIZE) {
    return blocks;
  }

  const result: NotionBlock[] = [];
  let currentGroup: NotionBlock[] = [];

  for (const block of blocks) {
    // Check if the block is a list item.
    if (isListItem(block)) {
      currentGroup.push(block);
    } else {
      // If we encounter a non-list item, we need to process any existing group.
      if (currentGroup.length > 0) {
        processGroup(result, currentGroup);
        currentGroup = []; // Reset the group
      }
      // Add the non-list item to the result.
      result.push(block);
    }
  }

  // After the loop, there might be a final group of list items to process.
  if (currentGroup.length > 0) {
    processGroup(result, currentGroup);
  }

  // Log the outcome of the optimization.
  if (result.length < blocks.length) {
    verbose(
      `List optimization successful: Reduced ${blocks.length} blocks to ${result.length}.`
    );
  }

  return result;
}

// Helper function to check if a block is a list item.
function isListItem(block: NotionBlock): boolean {
  return (
    block.type === "bulleted_list_item" ||
    block.type === "numbered_list_item" ||
    block.type === "to_do"
  );
}

// Helper function to process a group of list items.
function processGroup(result: NotionBlock[], group: NotionBlock[]): void {
  // If a group is small, it's not worth creating a virtual group block.
  const MIN_GROUP_SIZE_TO_OPTIMIZE = 3;
  if (group.length < MIN_GROUP_SIZE_TO_OPTIMIZE) {
    result.push(...group);
  } else {
    // For larger groups, create a single virtual block.
    // This is the core of the optimization.
    result.push({
      type: LIST_ITEM_GROUP_TYPE,
      id: `group-${group[0].id}`, // Create a stable ID for the group
      has_children: false, // The group block itself doesn't have children in Notion's view
      [LIST_ITEM_GROUP_TYPE]: {
        // Store the original blocks inside our virtual block.
        children: group,
      },
    } as NotionBlock);
  }
}

// This is the plugin definition that will be registered.
// For now, it's just a placeholder. The real magic happens in the custom transformer.
export const listOptimizerPlugin: IPlugin = {
  name: "List Optimizer",
};

// We need to teach notion-to-md how to handle our new 'list_item_group' type.
// This function will be called from transform.ts to register the custom transformer.
export function addListOptimizerTransformer(
  notionToMarkdown: any
): void {
  notionToMarkdown.setCustomTransformer(
    LIST_ITEM_GROUP_TYPE,
    async (block: any) => {
      // When notion-to-md encounters a 'list_item_group', it will run this code.
      const group = block[LIST_ITEM_GROUP_TYPE];
      if (!group || !group.children) return "";

      // We now process the children of the group in a batch.
      // This is much more efficient than processing each one individually.
      const childrenMarkdown = await notionToMarkdown.blocksToMarkdown(
        group.children
      );

      // Join the processed markdown of each child block.
      return notionToMarkdown.toMarkdownString(childrenMarkdown).parent;
    }
  );
  verbose("Registered custom transformer for list optimization.");
}
