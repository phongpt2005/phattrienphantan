import { Controller, ForbiddenException, Get, HttpException, HttpStatus, NotFoundException, Param, ParseIntPipe, Query, Req, Res, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { Readable } from 'stream';
import { AuthenticatedUser, JwtAuthGuard, SERVICE_TOKEN_HEADER, isExecutive, requireEnv } from '@dms/common';
import { RegistryService } from '../registry/registry.service';

/**
 * Tải file tài liệu của phòng ban KHÁC (đường duy nhất cho tải liên phòng).
 *
 *   Người dùng ──▶ Gateway ──▶ node CHỦ tài liệu ──▶ stream file
 *
 * Gateway KHÔNG tự quyết quyền: nó chỉ chuyển tên phòng của người dùng cho node chủ, và node chủ tự đối chiếu sổ chia sẻ
 * của chính nó (phải có lượt DOWNLOAD còn hiệu lực), ghi audit rồi mới mở file. Nhờ vậy đường này KHÔNG phụ thuộc
 * CSDL trung tâm: trung tâm sập vẫn tải được những gì đã được cấp, và thu hồi có hiệu lực ngay tại node.
 * Gateway chỉ cần danh bạ (bản chụp được) để biết node chủ ở đâu; địa chỉ MinIO không bao giờ lộ ra ngoài.
 */
@Controller('search/documents')
@UseGuards(JwtAuthGuard)
export class DocumentAccessController {
  constructor(private readonly registry: RegistryService) {}

  @Get(':dept/:docId/download')
  async download(
    @Param('dept') dept: string,
    @Param('docId', ParseIntPipe) docId: number,
    @Query('version') version: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const user = req.user as AuthenticatedUser;
    const code = String(dept).toUpperCase();
    const node = (await this.registry.listForSearch()).find((d) => d.dept_code === code);
    if (!node) throw new NotFoundException(`Không có phòng ban "${code}"`);
    if (node.lifecycle !== 'ACTIVE' || !node.node_endpoint) {
      throw new ServiceUnavailableException(`Node phòng ${code} hiện không sẵn sàng nên chưa tải được tài liệu của phòng này. Vui lòng thử lại sau.`);
    }

    const url = new URL(`${node.node_endpoint}/internal/files/${docId}/stream`);
    if (version) url.searchParams.set('version', String(Number(version)));
    url.searchParams.set('actor', `${user.username}@${user.departmentCode}`);
    url.searchParams.set('viewerDept', user.departmentCode);
    url.searchParams.set('viewerExec', String(isExecutive(user)));

    let up: globalThis.Response;
    try {
      up = await fetch(url, { headers: { [SERVICE_TOKEN_HEADER]: requireEnv('INTERNAL_SERVICE_TOKEN') }, signal: AbortSignal.timeout(15000) });
    } catch {
      throw new ServiceUnavailableException(`Không kết nối được node ${code}`);
    }
    if (up.status === 403) {
      const body: any = await up.json().catch(() => null);
      throw new ForbiddenException(body?.message || 'Phòng ban của bạn chưa được cấp quyền tải tài liệu này');
    }
    if (up.status === 404) throw new NotFoundException('Không tìm thấy tài liệu hoặc phiên bản tại node chủ sở hữu');
    if (up.status === 503) {
      // Sự cố hạ tầng lưu trữ của node chủ (MinIO): chuyển tiếp NGUYÊN VĂN 503 + errorCode, không đổi thành 500
      const body: any = await up.json().catch(() => null);
      throw new HttpException(
        {
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          errorCode: body?.errorCode ?? 'NODE_UNAVAILABLE',
          message: body?.message ?? `Node phòng ${code} tạm thời gián đoạn. Vui lòng thử lại sau.`,
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (!up.ok || !up.body) throw new ServiceUnavailableException(`Node ${code} trả lỗi ${up.status}`);

    for (const h of ['content-type', 'content-disposition', 'content-length', 'x-checksum-sha256']) {
      const v = up.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    const body = Readable.fromWeb(up.body as any);
    body.on('error', () => res.destroy()); // node đứt giữa chừng: ngắt để client không nhận tệp cụt như tệp hợp lệ
    body.pipe(res);
  }
}
