export function normalizePublications(publications) {
  const items = [];
  const seenBySource = new Map();
  for (const { source, record } of publications) {
    let seen = seenBySource.get(source.id);
    if (!seen) {
      seen = new Set();
      seenBySource.set(source.id, seen);
    }
    if (seen.has(record.externalId)) continue;

    const { brand, category, color, material, price } = record.attributes;
    if (typeof brand !== 'string' || !brand.trim()) {
      throw new TypeError('brand must be a non-empty string');
    }
    if (price != null && (!Number.isFinite(price) || price < 0)) {
      throw new TypeError('price must be a non-negative number');
    }
    seen.add(record.externalId);
    items.push({
      id: JSON.stringify([source.id, record.externalId]),
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
