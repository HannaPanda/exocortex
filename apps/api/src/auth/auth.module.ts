import { Module } from '@nestjs/common';

import { AuthController, SessionController, WellKnownController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  controllers: [AuthController, SessionController, WellKnownController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
