export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  hasNext: boolean;
}

/** `page` is 1-based, as documented in the README. */
export function paginate<T>(all: T[], page: number, pageSize: number): Page<T> {
  const start = page * pageSize;
  const items = all.slice(start, start + pageSize);
  return { items, page, pageSize, total: all.length, hasNext: start + pageSize < all.length };
}
