import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { requestContextStorage } from './request-context';

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    requestContextStorage.run(
      {
        req: req as unknown as Parameters<
          typeof requestContextStorage.run
        >[0]['req'],
      },
      () => {
        next();
      },
    );
  }
}
