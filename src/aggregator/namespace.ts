import type { ToolDescriptor, ResourceDescriptor, PromptDescriptor } from '../types/common.js';

/**
 * Namespace a tool name with server alias prefix.
 * Format: ${alias}__${toolName}
 */
export function namespaceTool(alias: string, tool: ToolDescriptor): ToolDescriptor {
  return {
    ...tool,
    name: `${alias}__${tool.name}`,
  };
}

/**
 * Namespace a resource URI with mcp+ prefix.
 * Format: mcp+${alias}://${originalUri}
 */
export function namespaceResource(alias: string, resource: ResourceDescriptor): ResourceDescriptor {
  return {
    ...resource,
    uri: `mcp+${alias}://${resource.uri}`,
  };
}

/**
 * Namespace a prompt name with server alias prefix.
 * Format: ${alias}__${promptName}
 */
export function namespacePrompt(alias: string, prompt: PromptDescriptor): PromptDescriptor {
  return {
    ...prompt,
    name: `${alias}__${prompt.name}`,
  };
}

/**
 * Parse a namespaced tool/prompt name back to alias and original name.
 * Returns null if name doesn't match expected format.
 */
export function parseNamespacedName(namespacedName: string): { alias: string; name: string } | null {
  const match = namespacedName.match(/^([a-z][a-z0-9-]*)__(.+)$/);
  if (!match) return null;
  return { alias: match[1], name: match[2] };
}

/**
 * Parse a namespaced resource URI back to alias and original URI.
 * Returns null if URI doesn't match expected format.
 */
export function parseNamespacedUri(namespacedUri: string): { alias: string; uri: string } | null {
  const match = namespacedUri.match(/^mcp\+([a-z][a-z0-9-]*):\/\/(.+)$/);
  if (!match) return null;
  return { alias: match[1], uri: match[2] };
}
