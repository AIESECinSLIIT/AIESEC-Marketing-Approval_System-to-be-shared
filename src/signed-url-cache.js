// In-memory only. Never cache file contents or persist private download links.
export function createSignedUrlCache({
  ttl = 50 * 60 * 1000,
  now = Date.now,
} = {}) {
  let scope = null,
    generation = 0;
  const entries = new Map();
  return {
    setScope(id) {
      if (scope !== id) {
        scope = id;
        generation++;
        entries.clear();
      }
    },
    async resolve(paths, sign) {
      const result = {},
        missing = [],
        epoch = generation;
      for (const path of new Set(paths.filter(Boolean))) {
        const cached = entries.get(path);
        if (cached && cached.until > now()) result[path] = cached.url;
        else missing.push(path);
      }
      if (missing.length) {
        const signed = await sign(missing);
        for (const item of signed)
          if (item.signedUrl) {
            result[item.path] = item.signedUrl;
            if (epoch === generation && scope)
              entries.set(item.path, {
                url: item.signedUrl,
                until: now() + ttl,
              });
          }
        while (entries.size > 250) entries.delete(entries.keys().next().value);
      }
      return result;
    },
  };
}
