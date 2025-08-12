import { NotionBlock } from "../types";
import { blocksToMarkdown } from "./pluginTestRun";
import { standardHeadingTransformer } from "./HeadingTransformer";

test("Adds anchor to headings and shifts levels down", async () => {
  //setLogLevel("verbose");
  const headingBlockId = "86f746f4-1c79-4ba1-a2f6-a1d59c2f9d23";
  const config = { plugins: [standardHeadingTransformer] };
  const result = await blocksToMarkdown(config, [
    {
      object: "block",
      id: headingBlockId,
      type: "heading_1",
      heading_1: {
        rich_text: [
          {
            type: "text",
            text: { content: "Heading One", link: null },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: "default",
            },
            plain_text: "Heading One",
            href: null,
          },
        ],
        is_toggleable: false,
        color: "default",
      },
    } as unknown as NotionBlock,
  ]);
  // H1 should become H2 (# becomes ##)
  expect(result.trim()).toBe(
    `## Heading One {#${headingBlockId.replaceAll("-", "")}}`
  );
});

test("H3 becomes H4 with proper markdown syntax", async () => {
  const headingBlockId = "23ffa6da-3fef-801c-8982-ee61757836e8";
  const config = { plugins: [standardHeadingTransformer] };
  const result = await blocksToMarkdown(config, [
    {
      object: "block",
      id: headingBlockId,
      type: "heading_3",
      heading_3: {
        rich_text: [
          {
            type: "text",
            text: { content: "Heading 3 Test", link: null },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: "default",
            },
            plain_text: "Heading 3 Test",
            href: null,
          },
        ],
        is_toggleable: false,
        color: "default",
      },
    } as unknown as NotionBlock,
  ]);
  // H3 should become H4 (### becomes ####)
  expect(result.trim()).toBe(
    `#### Heading 3 Test {#${headingBlockId.replaceAll("-", "")}}`
  );
});
