import { Controller, Post, Get, Body, UseGuards, Request } from '@nestjs/common'
import { AuthService } from './auth.service'
import { JwtAuthGuard } from './guards/jwt-auth.guard'
import { LocalAuthGuard } from './guards/local-auth.guard'
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger'

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Post('register')
  @ApiOperation({ summary: 'Register new user' })
  async register(
    @Body()
    dto: {
      email: string
      username: string
      password: string
      firstName?: string
      lastName?: string
    },
  ) {
    return this.auth.register(dto.email, dto.username, dto.password, dto.firstName, dto.lastName)
  }

  @Post('login')
  @UseGuards(LocalAuthGuard)
  @ApiOperation({ summary: 'Login user' })
  async login(@Request() req) {
    return this.auth.login(req.user)
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Refresh access token' })
  async refreshToken(@Body() dto: { refreshToken: string }) {
    return this.auth.refreshToken(dto.refreshToken)
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @ApiOperation({ summary: 'Get current user' })
  async getCurrentUser(@Request() req) {
    return req.user
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @ApiOperation({ summary: 'Logout user' })
  async logout(@Request() req) {
    return this.auth.logout(req.user.sub, req.user.sessionToken)
  }

  @Post('2fa/enable')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @ApiOperation({ summary: 'Enable 2FA' })
  async enableTwoFactor(@Request() req) {
    return this.auth.enableTwoFactor(req.user.sub)
  }

  @Post('2fa/verify')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @ApiOperation({ summary: 'Verify 2FA token' })
  async verifyTwoFactor(@Request() req, @Body() dto: { token: string }) {
    const isValid = await this.auth.verifyTwoFactor(req.user.sub, dto.token)
    return { isValid }
  }
}
