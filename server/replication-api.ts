import type { IncomingMessage, ServerResponse } from "node:http";
import type { PlatformStore } from "./platform-store.ts";
import type { TenantManager } from "./tenant-manager.ts";
import { ApiError } from "../lib/service.ts";
import { json, readJson, requestToken } from "./platform-http.ts";
import { loadMedia } from "./media.ts";
import {
  authorizeReplica,
  pairReplica,
  mergeReplica,
  replicaSnapshot,
  initializeReplication,
} from "./replication.ts";

export async function replicationApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  gymId: string,
  store: PlatformStore,
  manager: TenantManager,
) {
  const action = url.pathname.split("/").slice(5).join("/"),
    method = req.method || "GET";
  const gym = store.requireOperationalGym(gymId);
  if (
    ["pair", "devices", "conflicts"].includes(action) ||
    /^(devices|conflicts)\//.test(action)
  ) {
    const token = requestToken(req);
    const support = String(req.headers["x-gympass-support"] || "");
    const auth = await store.authorize(token, gymId, support, true);
    if (auth.support && action === "pair")
      throw new ApiError(
        403,
        "La vinculación requiere una cuenta del gimnasio.",
      );
    if (action !== "pair" && auth.actor.role !== "admin")
      throw new ApiError(
        403,
        "Solo el administrador gestiona las vinculaciones.",
      );
    const body = method === "GET" ? {} : await readJson(req, 20000);
    return manager.withTenant(gym, async (ctx) => {
      const fresh = store.authorizeSync(token, gymId, support, true);
      initializeReplication(ctx.db.raw);
      if (action === "pair" && method === "POST") {
        const paired = pairReplica(
          ctx,
          fresh,
          body,
          store.linkedCredentialRevision(fresh.user.id),
        );
        store.audit(auth.user.id, "sync.paired", gymId, paired.id);
        return json(res, paired, 201);
      }
      if (action === "devices" && method === "GET")
        return json(
          res,
          ctx.db.raw
            .prepare(
              "SELECT id,name,kind,user_id,created_at,last_sync_at,expires_at,revoked_at FROM sync_devices ORDER BY created_at DESC",
            )
            .all(),
        );
      if (action === "conflicts" && method === "GET")
        return json(
          res,
          ctx.db.raw
            .prepare(
              "SELECT b.device_id,b.batch_id,b.created_at,b.conflict,d.name,d.kind FROM sync_batches b JOIN sync_devices d ON d.id=b.device_id WHERE b.status='conflict' ORDER BY b.created_at",
            )
            .all(),
        );
      const parts = action.split("/");
      if (
        parts[0] === "conflicts" &&
        parts.length === 4 &&
        parts[3] === "export" &&
        method === "GET"
      ) {
        const batch = ctx.db.raw
          .prepare(
            "SELECT patch_json FROM sync_batches WHERE device_id=? AND batch_id=?",
          )
          .get(parts[1], parts[2]);
        if (!batch) throw new ApiError(404, "No se encontró el lote.");
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Disposition": 'attachment; filename="pendientes.json"',
          "Cache-Control": "no-store",
        });
        return res.end(String(batch.patch_json));
      }
      if (parts[0] === "devices" && parts.length === 2 && method === "DELETE") {
        ctx.db.raw
          .prepare("UPDATE sync_devices SET revoked_at=? WHERE id=?")
          .run(Date.now(), parts[1]);
        store.audit(auth.user.id, "sync.revoked", gymId, parts[1]);
        return json(res, { ok: true });
      }
      if (
        parts[0] === "devices" &&
        parts.length === 2 &&
        method === "POST" &&
        body.confirm === "REACTIVAR"
      ) {
        const device = ctx.db.raw
          .prepare("SELECT user_id FROM sync_devices WHERE id=?")
          .get(parts[1]);
        if (!device) throw new ApiError(404, "No se encontró el dispositivo.");
        ctx.db.raw
          .prepare(
            "UPDATE sync_devices SET revoked_at=NULL,expires_at=?,password_revision=? WHERE id=?",
          )
          .run(
            Date.now() + 90 * 86400000,
            store.linkedCredentialRevision(String(device.user_id)),
            parts[1],
          );
        store.audit(auth.user.id, "sync.reactivated", gymId, parts[1]);
        return json(res, { ok: true });
      }
      if (
        parts[0] === "conflicts" &&
        parts.length === 3 &&
        method === "POST" &&
        body.confirm === "CONSERVAR NUBE"
      ) {
        ctx.db.raw
          .prepare(
            "UPDATE sync_batches SET status='archived' WHERE device_id=? AND batch_id=? AND status='conflict'",
          )
          .run(parts[1], parts[2]);
        store.audit(auth.user.id, "sync.conflict_archived", gymId, parts[2]);
        return json(res, { ok: true });
      }
      throw new ApiError(404, "Operación de sincronización no disponible.");
    });
  }
  const token = req.headers.authorization?.match(
    /^Bearer (s_[a-f\d]{64})$/,
  )?.[1];
  if (!token)
    throw new ApiError(401, "Falta la clave del dispositivo vinculado.");
  await manager.withTenant(gym, async (ctx) => {
    authorizeReplica(store, ctx, token);
  });
  const body = method === "GET" ? {} : await readJson(req, 64 * 1024 * 1024);
  return manager.withTenant(gym, async (ctx) => {
    const { device, auth } = authorizeReplica(store, ctx, token);
    if (action === 'photo' && method === 'GET') {
      const person = ctx.db.raw.prepare('SELECT photo_path FROM people WHERE id=? AND deleted_at IS NULL')
        .get(url.searchParams.get('person') || '');
      if (!person?.photo_path || !/\.(png|webp)$/.test(String(person.photo_path)))
        throw new ApiError(404, 'Esta persona no tiene foto.');
      const bytes = await loadMedia(ctx.root, 'photos', String(person.photo_path));
      authorizeReplica(store, ctx, token);
      if (bytes.length > 2 * 1024 * 1024) throw new ApiError(413, 'La foto es demasiado grande.');
      return json(res, { photo_path: person.photo_path,
        data_uri: `data:image/${String(person.photo_path).endsWith('.webp') ? 'webp' : 'png'};base64,${bytes.toString('base64')}` });
    }
    if (action === "snapshot" && method === "GET") {
      const snapshot = await replicaSnapshot(ctx, device, auth);
      authorizeReplica(store, ctx, token);
      if (url.searchParams.get("revision") === snapshot.revision)
        return json(res, {
          unchanged: true,
          revision: snapshot.revision,
          gym_id: snapshot.gym_id,
          installation_id: snapshot.installation_id,
          issued_at: snapshot.issued_at,
          expires_at: snapshot.expires_at,
          user: snapshot.user,
        });
      return json(res, snapshot);
    }
    if (action === "push" && method === "POST") {
      const result = mergeReplica(ctx, device, auth, body as any);
      store.audit(
        auth.user.id,
        "sync." + result.status,
        gymId,
        String(body.id),
      );
      const ids: Record<string, number> = {};
      if (result.status !== "conflict")
        for (const change of body.changes || [])
          if (change.table === "events" && !change.before && change.after) {
            const row = ctx.db.raw
              .prepare("SELECT id FROM events WHERE request_key=?")
              .get(change.after.request_key);
            if (row) ids[String(change.after.id)] = Number(row.id);
          }
      return json(res, {
        ...result,
        event_ids: ids,
        ...(result.status === "conflict"
          ? {}
          : { snapshot: await replicaSnapshot(ctx, device, auth) }),
      });
    }
    throw new ApiError(404, "Operación de sincronización no disponible.");
  });
}
