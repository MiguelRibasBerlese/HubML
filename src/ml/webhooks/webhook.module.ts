import { Module } from '@nestjs/common';
import { PrismaService } from '../../lib/prisma.service';
import { WebhookController } from './webhook.controller';

@Module({
  controllers: [WebhookController],
  providers: [PrismaService],
})
export class WebhookModule {}
