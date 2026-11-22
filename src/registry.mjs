export class Registry {
  #tools = new Map();

  constructor(tools = []) {
    for (const tool of tools) {
      if (typeof tool?.sourceType !== 'string' || !tool.sourceType || typeof tool.collect !== 'function') {
        throw new TypeError('Tool must declare sourceType and collect()');
      }
      if (this.#tools.has(tool.sourceType)) {
        throw new TypeError(`Duplicate operation: ${tool.sourceType}`);
      }
      this.#tools.set(tool.sourceType, tool);
    }
  }

  get(operation) {
    const tool = this.#tools.get(operation);
    if (!tool) {
      throw Object.assign(new Error(`Unknown operation: ${operation}`), {
        code: 'unknown_operation',
        field: 'source.type',
      });
    }
    return tool;
  }
}
