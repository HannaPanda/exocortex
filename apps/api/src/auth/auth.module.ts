import { Module } from '@nestjs/common';

import { AuthController, SessionController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  controllers: [AuthController, SessionController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
