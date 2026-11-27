import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  ParseIntPipe,
  ValidationPipe,
  Headers,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { DocumentService } from './document.service';
import { CreateDocumentDto } from '../../dto/create-document.dto';
import { UpdateDocumentDto } from '../../dto/update-document.dto';
import { CreateVersionDto } from '../../dto/create-version.dto';
import { DepartmentGuard, Roles, RolesGuard, AuthenticatedUser } from '@dms/common';

@Controller('documents')
@UseGuards(AuthGuard('jwt'), DepartmentGuard, RolesGuard)
export class DocumentController {
  constructor(private readonly documentService: DocumentService) {}

  @Post()
  @UseInterceptors(FileInterceptor('file'))
  async create(
    @Body(new ValidationPipe({ transform: true })) dto: CreateDocumentDto,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    const user = req.user as AuthenticatedUser;
    dto.userId = user.userId;
    const ipAddress = req.ip || req.socket.remoteAddress;
    try {
      if (idemKey !== undefined) {
        const r = await this.documentService.createIdempotent(dto, file, ipAddress, user.role, idemKey);
        if (r.replayed) res.setHeader('Idempotent-Replayed', 'true');
        return r.body;
      }
      return await this.documentService.create(dto, file, ipAddress, user.role);
    } catch (e) {
      // 409 (khóa đang xử lý) và 503 (CSDL tạm thời lỗi) là lỗi thử lại được: báo client chờ bao lâu
      if (e instanceof ConflictException || e instanceof ServiceUnavailableException) res.setHeader('Retry-After', '2');
      throw e;
    }
  }

  @Post(':id/approve')
  @Roles('ADMIN', 'MANAGER')
  async approve(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: Request,
  ) {
    const user = req.user as AuthenticatedUser;
    const ipAddress = req.ip || req.socket.remoteAddress;
    return this.documentService.approveDocument(id, user.userId, ipAddress);
  }

  @Get()
  async findAll(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('categoryId') categoryId?: number,
    @Query('status') status?: string,
  ) {
    return this.documentService.findAll({ page, limit, categoryId, status });
  }

  @Get(':id')
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: Request,
  ) {
    const user = req.user as AuthenticatedUser;
    const ipAddress = req.ip || req.socket.remoteAddress;
    return this.documentService.findOne(id, user.userId, ipAddress);
  }

  @Get(':id/audit-logs')
  async getAuditLogs(
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.documentService.getAuditLogs(id);
  }

  @Put(':id')
  @Roles('ADMIN', 'MANAGER', 'STAFF')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ValidationPipe({ transform: true })) dto: UpdateDocumentDto,
    @Req() req: Request,
  ) {
    const user = req.user as AuthenticatedUser;
    dto.userId = user.userId;
    const ipAddress = req.ip || req.socket.remoteAddress;
    return this.documentService.update(id, dto, ipAddress, user);
  }

  @Post(':id/versions')
  @Roles('ADMIN', 'MANAGER', 'STAFF')
  @UseInterceptors(FileInterceptor('file'))
  async addVersion(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ValidationPipe({ transform: true })) dto: CreateVersionDto,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request,
  ) {
    const user = req.user as AuthenticatedUser;
    dto.userId = user.userId;
    const ipAddress = req.ip || req.socket.remoteAddress;
    return this.documentService.addVersion(id, dto, file, ipAddress);
  }

  @Get(':id/download')
  async download(
    @Param('id', ParseIntPipe) id: number,
    @Query('version') version: number,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const user = req.user as AuthenticatedUser;
    const ipAddress = req.ip || req.socket.remoteAddress;
    const { stream, fileRecord } = await this.documentService.download(
      id,
      version,
      user.userId,
      ipAddress,
    );

    res.set({
      'Content-Type': fileRecord.mimeType,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(fileRecord.fileName)}"`,
      'Content-Length': fileRecord.sizeBytes.toString(),
      'X-Checksum-SHA256': fileRecord.checksumSha256,
    });

    stream.pipe(res);
  }

  @Delete(':id')
  @Roles('ADMIN', 'MANAGER')
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: Request,
  ) {
    const user = req.user as AuthenticatedUser;
    const ipAddress = req.ip || req.socket.remoteAddress;
    return this.documentService.remove(id, user.userId, ipAddress, user.role);
  }
}
