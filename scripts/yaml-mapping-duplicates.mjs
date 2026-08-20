function mappingKey(item) {
  const wrapper = item?.children?.[0];
  const key = wrapper?.type === "mappingKey" ? wrapper.children?.[0] : wrapper;
  if (key?.type === "plain" || key?.type === "quoteDouble" || key?.type === "quoteSingle") {
    return typeof key.value === "string" ? key.value : undefined;
  }
  return undefined;
}

export function findYamlMappingDuplicates(root) {
  const duplicates = [];
  function visit(node) {
    if (typeof node !== "object" || node === null) return;
    if (node.type === "mapping" && Array.isArray(node.children)) {
      const seen = new Map();
      for (const item of node.children) {
        const key = mappingKey(item);
        if (key === undefined) continue;
        const line = item?.position?.start?.line;
        const firstLine = seen.get(key);
        if (firstLine !== undefined) duplicates.push({ firstLine, key, line });
        else if (Number.isInteger(line)) seen.set(key, line);
      }
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) visit(child);
    }
  }
  visit(root);
  return duplicates;
}
