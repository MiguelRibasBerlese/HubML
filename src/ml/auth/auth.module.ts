import { Module } from '@nestjs/common';
import { PrismaService } from '../../lib/prisma.service';
import { TokenStore } from './token-store.service';
import { AuthController } from './auth.controller';

@Module({
  controllers: [AuthController],
  providers: [PrismaService, TokenStore],
  exports: [TokenStore],
})
export class AuthModule {}
