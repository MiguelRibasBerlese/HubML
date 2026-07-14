import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../lib/prisma.service';
import { withContext } from '../../lib/logger';

interface MlNotification {
  resource: string;
  topic: string;
  user_id?: number;
  application_id?: number;
  sent?: string;
  attempts?: number;
}

/**
 * Endpoint "burro" de notificações (§2, risco de fallback): APENAS insere na inbox
 * e responde 200 — nada de processamento síncrono. O ML exige 200 em <500ms, senão
 * desativa o tópico. Dedupe por hash(topic+resource+sent). Worker processa depois (M8).
 */
@Controller('webhooks/ml')
export class WebhookController {
  private readonly log = withContext({ op: 'webhook-inbox' });

  constructor(private readonly prisma: PrismaService) {}

  @Post()
  @HttpCode(200)
  async receive(@Body() body: MlNotification): Promise<{ ok: true }> {
    const dedupeKey = createHash('sha256')
      .update(`${body.topic}|${body.resource}|${body.sent ?? ''}`)
      .digest('hex');

    // ON CONFLICT DO NOTHING: reentrega do ML não duplica. Insert-only = rápido.
    await this.prisma.$executeRaw`
      INSERT INTO webhook_event (id, topic, resource, payload, dedupe_key, status, attempts, received_at)
      VALUES (gen_random_uuid(), ${body.topic ?? ''}, ${body.resource ?? ''},
              ${JSON.stringify(body)}::jsonb, ${dedupeKey}, 'pending', 0, now())
      ON CONFLICT (dedupe_key) DO NOTHING`;

    this.log.debug({ topic: body.topic, resource: body.resource }, 'notificação enfileirada');
    return { ok: true };
  }
}
