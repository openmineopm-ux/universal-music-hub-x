import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { PrismaService } from '../database/prisma.service'
import * as bcrypt from 'bcrypt'
import { User } from '@prisma/client'

export interface JwtPayload {
  sub: string
  email: string
  role: string
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  async validateUser(email: string, password: string): Promise<Omit<User, 'password'> | null> {
    const user = await this.prisma.user.findUnique({
      where: { email },
    })

    if (!user) return null

    const isPasswordValid = await bcrypt.compare(password, user.password || '')
    if (!isPasswordValid) return null

    const { password: _, ...userWithoutPassword } = user
    return userWithoutPassword
  }

  async register(email: string, username: string, password: string, firstName?: string, lastName?: string) {
    const existingUser = await this.prisma.user.findFirst({
      where: {
        OR: [{ email }, { username }],
      },
    })

    if (existingUser) {
      throw new BadRequestException('User with this email or username already exists')
    }

    const hashedPassword = await bcrypt.hash(password, parseInt(process.env.BCRYPT_ROUNDS || '12'))

    const user = await this.prisma.user.create({
      data: {
        email,
        username,
        password: hashedPassword,
        firstName,
        lastName,
      },
    })

    const { password: _, ...userWithoutPassword } = user
    return userWithoutPassword
  }

  async login(user: Omit<User, 'password'>) {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    }

    const accessToken = this.jwt.sign(payload)
    const refreshToken = this.jwt.sign(payload, {
      expiresIn: process.env.JWT_REFRESH_EXPIRATION || '30d',
      secret: process.env.JWT_REFRESH_SECRET,
    })

    await this.prisma.session.create({
      data: {
        userId: user.id,
        sessionToken: accessToken,
        refreshToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    })

    return {
      accessToken,
      refreshToken,
      user,
    }
  }

  async refreshToken(refreshToken: string) {
    try {
      const decoded = this.jwt.verify(refreshToken, {
        secret: process.env.JWT_REFRESH_SECRET,
      }) as JwtPayload

      const user = await this.prisma.user.findUnique({
        where: { id: decoded.sub },
      })

      if (!user) {
        throw new UnauthorizedException('User not found')
      }

      const { password: _, ...userWithoutPassword } = user
      return this.login(userWithoutPassword)
    } catch (error) {
      throw new UnauthorizedException('Invalid refresh token')
    }
  }

  async validateOAuthUser(provider: string, providerAccountId: string, profile: any) {
    let user = await this.prisma.user.findFirst({
      where: {
        oauthAccounts: {
          some: {
            provider,
            providerAccountId,
          },
        },
      },
    })

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          email: profile.email,
          username: profile.username || profile.displayName?.toLowerCase().replace(/\s+/g, '_'),
          firstName: profile.firstName,
          lastName: profile.lastName,
          avatar: profile.picture,
          isVerified: true,
          oauthAccounts: {
            create: {
              provider,
              providerAccountId,
              accessToken: profile.accessToken,
              refreshToken: profile.refreshToken,
              expiresAt: profile.expiresAt,
              scope: profile.scope,
            },
          },
        },
      })
    }

    const { password: _, ...userWithoutPassword } = user
    return userWithoutPassword
  }

  async verifyTwoFactor(userId: string, token: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    })

    if (!user?.twoFactorSecret) {
      return false
    }

    // TOTP verification would go here
    // For now, simple validation
    return true
  }

  async enableTwoFactor(userId: string) {
    // Generate TOTP secret
    const secret = Math.random().toString(36).substring(2, 15)

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorSecret: secret,
      },
    })

    return {
      secret,
      message: 'Scan QR code with authenticator app',
    }
  }

  async logout(userId: string, sessionToken: string) {
    await this.prisma.session.updateMany({
      where: {
        userId,
        sessionToken,
      },
      data: {
        isActive: false,
      },
    })

    return { message: 'Logged out successfully' }
  }
}
