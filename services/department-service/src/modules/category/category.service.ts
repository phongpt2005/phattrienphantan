import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@dms/database';
import { sanitizeBigInt } from '@dms/common';

@Injectable()
export class CategoryService {
  constructor(private readonly prisma: PrismaClient) {}

  async findAll() {
    const categories = await this.prisma.category.findMany({
      include: {
        children: true,
      },
      orderBy: { categoryId: 'asc' },
    });
    return sanitizeBigInt(categories);
  }

  async findTree() {
    const roots = await this.prisma.category.findMany({
      where: { parentId: null },
      include: {
        children: {
          include: {
            children: true,
          },
        },
      },
      orderBy: { categoryId: 'asc' },
    });
    return sanitizeBigInt(roots);
  }

  async findOne(id: number) {
    const category = await this.prisma.category.findUnique({
      where: { categoryId: id },
      include: { children: true },
    });
    return sanitizeBigInt(category);
  }
}
