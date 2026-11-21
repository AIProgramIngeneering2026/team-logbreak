export function normalizePublications(publications) {
  const items = [];
  const seen = new Set();
  for (const { source, record } of publications) {
    const id = JSON.stringify([source.id, record.externalId]);
    if (seen.has(id)) continue;

    const { brand, category, color, material, price } = record.attributes;
    if (typeof brand !== 'string' || !brand.trim()) {
      throw new TypeError('brand must be a non-empty string');
    }
    if (price != null && (!Number.isFinite(price) || price < 0)) {
      throw new TypeError('price must be a non-negative number');
    }
    seen.add(id);
    items.push({
      id,
      brand: brand.trim(),
      category: optionalText(category),
      color: optionalText(color),
      material: optionalText(material),
      price: price ?? null,
      sourceType: source.type,
      publishedAt: record.publishedAt,
      originalUrl: record.originalUrl,
      originUrls: [record.originalUrl],
    });
  }
  return items;
}

function optionalText(value) {
  if (value == null) return null;
  if (typeof value !== 'string') throw new TypeError('Expected a string attribute');
  return value.trim() || null;
}
