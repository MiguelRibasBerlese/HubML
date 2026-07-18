import { Module } from '@nestjs/common';
import { MoovinXlsxSource } from './xlsx-source';
import { MOOVIN_SOURCE } from './source.interface';
import { env } from '../config/env';

// Fronteira: tudo que fala com a origem de dados da Moovin (hoje xlsx, amanhã
// a API docs.moovin.app) vive aqui e é exportado só pela interface MoovinSource.
@Module({
  providers: [
    {
      provide: MOOVIN_SOURCE,
      useFactory: () => new MoovinXlsxSource(env().MOOVIN_IMPORT_FILE_PATH),
    },
  ],
  exports: [MOOVIN_SOURCE],
})
export class MoovinModule {}
