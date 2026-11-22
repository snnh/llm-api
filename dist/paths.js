/** Minimal path reader: supports `$.a.b`, arrays by index, and `[*]` expansion. */
export function selectPath(root, expression) {
    const segments = expression
        .replace(/^\$\.?/, '')
        .replace(/\[\*\]/g, '.[*]')
        .split('.')
        .filter(Boolean);
    const walk = (value, index) => {
        if (index >= segments.length)
            return [value];
        const segment = segments[index];
        if (segment === '[*]') {
            return Array.isArray(value) ? value.flatMap((item) => walk(item, index + 1)) : [];
        }
        if (Array.isArray(value) && /^\d+$/.test(segment)) {
            return walk(value[Number(segment)], index + 1);
        }
        if (value !== null && typeof value === 'object') {
            return walk(value[segment], index + 1);
        }
        return [];
    };
    return walk(root, 0);
}
export function selectOne(root, expression) {
    return selectPath(root, expression)[0];
}
/** Like selectPath, but unwraps a single array result so `$.results` and `$.data[*]` both work. */
export function selectArray(root, expression) {
    const out = selectPath(root, expression);
    if (out.length === 1 && Array.isArray(out[0]))
        return out[0];
    return out;
}
