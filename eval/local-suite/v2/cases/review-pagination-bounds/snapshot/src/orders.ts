import { paginate, type Page } from './paginate';

export interface Order {
  id: string;
  customer: string;
  cents: number;
}

const ORDERS: Order[] = [
  { id: 'o1', customer: 'ana', cents: 1200 },
  { id: 'o2', customer: 'ana', cents: 560 },
  { id: 'o3', customer: 'ben', cents: 9900 },
  { id: 'o4', customer: 'ana', cents: 75 },
  { id: 'o5', customer: 'ana', cents: 4300 },
];

export function listOrders(customer: string): Order[] {
  return ORDERS.filter((o) => o.customer === customer);
}

export function listOrdersPage(customer: string, page: number, pageSize: number): Page<Order> {
  return paginate(listOrders(customer), page, pageSize);
}
