import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  // Lets you (and the client) check that the server is running.
  @Get()
  check(): { status: string } {
    return { status: 'ok' };
  }
}
