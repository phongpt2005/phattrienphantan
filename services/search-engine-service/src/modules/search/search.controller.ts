import { Controller, Get, Query, Req, UseGuards, ValidationPipe } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser, JwtAuthGuard } from '@dms/common';
import { SearchService } from './search.service';
import { SearchQueryDto } from '../../dto/search-query.dto';

@Controller('search')
@UseGuards(JwtAuthGuard)
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  /** Federated search. Người xem lấy từ JWT. */
  @Get()
  async search(@Query(new ValidationPipe({ transform: true })) query: SearchQueryDto, @Req() req: Request) {
    return this.searchService.search(query, req.user as AuthenticatedUser);
  }

  @Get('stats')
  async getStats() {
    return this.searchService.getStats();
  }

  @Get('catalog')
  async getCatalog(@Req() req: Request) {
    return this.searchService.getCatalog(req.user as AuthenticatedUser);
  }
}
