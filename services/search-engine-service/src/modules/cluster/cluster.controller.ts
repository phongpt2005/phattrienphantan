import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, Roles, RolesGuard } from '@dms/common';
import { ClusterService } from './cluster.service';

/** Bản đồ cụm và diễn biến chuyển đổi/phục hồi: chỉ Ban Giám đốc (ADMIN trong JWT). */
@Controller('search/executive')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class ClusterController {
  constructor(private readonly cluster: ClusterService) {}

  @Get('cluster')
  getCluster() {
    return this.cluster.getClusterMap();
  }
}
