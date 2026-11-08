# orders

`GET /orders?customer=<name>&page=<n>&pageSize=<n>` lists a customer's orders.
Pages are numbered from 1. `pageSize` defaults to 20. Callers keep requesting
the next page while `hasNext` is true.
