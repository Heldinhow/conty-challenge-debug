import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import { seedIncident } from "../src/seed.ts";

/**
 * Regressão do incidente de 2026-03-13 (logs/incident.jsonl).
 *
 * Replay fiel da sequência que quebrou os repasses naquela noite, com os
 * valores exatos do log. Cada `it` abaixo falha na main sem o fix e passa
 * com ele — se qualquer um voltar a falhar, o incidente voltou.
 *
 * Linha do tempo (sempre America/Sao_Paulo, UTC-3 em março):
 * - 01:02Z msn_1842 (15000 cents, prazo 2026-03-12) → rejeitada como
 *   "expired": o dia civil foi extraído em UTC (03-13) em vez de SP (03-12).
 * - 01:11Z msn_1900 (15000 cents) → creditada como 1.50 (divisão dupla).
 * - 01:11Z retry com chave "pay_22a " (espaço no fim) → creditada DE NOVO.
 * - 01:20Z callback PENDING do provedor → repasse marcado "paid".
 * - 01:21Z msn_2044 (8000 cents) com chave "pay_7c1\u200b" (zero-width
 *   space) → creditada de novo como 0.80.
 */
type App = ReturnType<typeof createApp>;

function setup(): App {
  const db = openDatabase(":memory:");
  seedIncident(db);
  return createApp(db);
}

async function postJson(app: App, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("regressão do incidente 2026-03-13", () => {
  let app: App;

  beforeEach(() => {
    app = setup();
  });

  it("msn_1842 aprovada às 22:02 de 12/03 em SP cai no dia do prazo, não em 13/03", async () => {
    const res = await postJson(app, "/approvals", {
      mission_id: "msn_1842",
      approved_at: "2026-03-13T01:02:00.000Z",
      idempotency_key: "pay_9f3",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ledger: { amount_brl: number } };
    expect(body.ledger.amount_brl).toBe(150);
  });

  it("msn_1900 de 15000 cents credita R$ 150, não R$ 1,50", async () => {
    const res = await postJson(app, "/approvals", {
      mission_id: "msn_1900",
      approved_at: "2026-03-12T18:11:00.000Z",
      idempotency_key: "pay_22a",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ledger: { amount_brl: number } };
    expect(body.ledger.amount_brl).toBe(150);
  });

  it("retry com 'pay_22a ' (espaço no fim) não credita msn_1900 duas vezes", async () => {
    expect(
      (await postJson(app, "/approvals", {
        mission_id: "msn_1900",
        approved_at: "2026-03-12T18:11:00.000Z",
        idempotency_key: "pay_22a",
      })).status,
    ).toBe(201);
    const retry = await postJson(app, "/approvals", {
      mission_id: "msn_1900",
      approved_at: "2026-03-12T18:11:00.000Z",
      idempotency_key: "pay_22a ",
    });
    expect(retry.status).toBeLessThan(500);
    const mission = await app.request("/missions/msn_1900");
    const body = (await mission.json()) as { ledger: unknown[] };
    expect(body.ledger).toHaveLength(1);
  });

  it("callback PENDING mantém o repasse pendente, não marca pago", async () => {
    const created = await postJson(app, "/approvals", {
      mission_id: "msn_2044",
      approved_at: "2026-03-20T15:00:00.000Z",
      idempotency_key: "pay_provider",
    });
    const { payout } = (await created.json()) as { payout: { id: string } };
    const res = await postJson(app, `/payouts/${payout.id}/provider`, {
      provider_status: "PENDING",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("pending");
  });

  it("chave 'pay_7c1\\u200b' (zero-width space) não credita msn_2044 duas vezes", async () => {
    expect(
      (await postJson(app, "/approvals", {
        mission_id: "msn_2044",
        approved_at: "2026-03-12T21:05:00.000Z",
        idempotency_key: "pay_7c1",
      })).status,
    ).toBe(201);
    const retry = await postJson(app, "/approvals", {
      mission_id: "msn_2044",
      approved_at: "2026-03-12T21:05:00.000Z",
      idempotency_key: "pay_7c1\u200b",
    });
    expect(retry.status).toBeLessThan(500);
    const mission = await app.request("/missions/msn_2044");
    const body = (await mission.json()) as {
      ledger: { amount_brl: number }[];
    };
    expect(body.ledger).toHaveLength(1);
    expect(body.ledger[0].amount_brl).toBe(80);
  });
});
