import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { MlClient } from './client/ml-client.service';
import { MlApi } from './api/ml-api.service';

// Fronteira: TUDO que fala com o ML vive sob src/ml e é exportado por este módulo.
@Module({
  imports: [AuthModule],
  providers: [MlClient, MlApi],
  exports: [MlApi, MlClient, AuthModule],
})
export class MlModule {}
