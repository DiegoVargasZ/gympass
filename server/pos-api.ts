import { PosService } from '../lib/pos.ts';
import { ApiError, type Service } from '../lib/service.ts';

export async function posRequest(
  service: Service,
  method: string,
  path: string[],
  body: unknown,
  params: URLSearchParams,
): Promise<{ data: unknown; status: number }> {
  const pos = new PosService(service);
  const [, resource, id, action] = path;
  if (method === 'GET' && path.length === 2) {
    if (resource === 'catalog') return { data: await pos.catalog(), status: 200 };
    if (resource === 'sales') return { data: await pos.sales(params), status: 200 };
    if (resource === 'reports') return { data: await pos.report(params), status: 200 };
  }
  if (method === 'GET' && path.length === 3) {
    if (resource === 'sales') return { data: await pos.sale(id), status: 200 };
    if (resource === 'memberships') return { data: await pos.memberships(id), status: 200 };
  }
  if (method === 'POST' && path.length === 2) {
    if (resource === 'products') return { data: await pos.saveProduct(body), status: 201 };
    if (resource === 'plans') return { data: await pos.savePlan(body), status: 201 };
    if (resource === 'checkout') return { data: await pos.checkout(body), status: 201 };
  }
  if (method === 'PATCH' && path.length === 3) {
    if (resource === 'products') return { data: await pos.saveProduct(body, id), status: 200 };
    if (resource === 'plans') return { data: await pos.savePlan(body, id), status: 200 };
  }
  if (method === 'POST' && path.length === 4) {
    if (resource === 'products' && action === 'stock') return { data: await pos.adjustStock(id, body), status: 200 };
    if (resource === 'sales' && action === 'void') return { data: await pos.voidSale(id, body), status: 200 };
  }
  throw new ApiError(404, 'Operación de punto de venta no encontrada.');
}
