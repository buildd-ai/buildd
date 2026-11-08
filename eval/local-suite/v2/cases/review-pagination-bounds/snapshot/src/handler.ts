import { listOrdersPage } from './orders';

type Query = Record<string, string | undefined>;

/** GET /orders?customer=ana&page=1&pageSize=20 */
export function handleList(q: Query) {
  const page = Number(q.page ?? '1');
  const pageSize = Number(q.pageSize ?? '20');
  return listOrdersPage(q.customer ?? '', page, pageSize);
}
