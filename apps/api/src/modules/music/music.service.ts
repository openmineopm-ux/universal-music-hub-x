import { Injectable, BadRequestException } from '@nestjs/common'
import axios from 'axios'
import { PrismaService } from '../database/prisma.service'
import { CacheService } from '../cache/cache.service'
import { Logger } from '../common/logger/logger.service'

export interface StreamingProvider {
  name: string
  isEnabled: boolean
  accessToken?: string
  refreshToken?: string
}

export interface PlayableTrack {
  id: string
  title: string
  artist: string
  provider: string
  url: string
  duration: number
}

@Injectable()
export class MusicStreamingService {
  private providers = {
    spotify: {
      baseUrl: 'https://api.spotify.com/v1',
      headers: { Authorization: `Bearer ${process.env.SPOTIFY_API_CLIENT_ID}` },
    },
    apple_music: {
      baseUrl: 'https://api.music.apple.com/v1/catalog',
      token: process.env.APPLE_MUSIC_DEVELOPER_TOKEN,
    },
    youtube_music: {
      baseUrl: 'https://www.googleapis.com/youtube/v3',
      apiKey: process.env.YOUTUBE_API_KEY,
    },
    soundcloud: {
      baseUrl: 'https://api.soundcloud.com/v2',
      clientId: process.env.SOUNDCLOUD_CLIENT_ID,
    },
    deezer: {
      baseUrl: 'https://api.deezer.com',
      accessToken: process.env.DEEZER_ACCESS_TOKEN,
    },
    tidal: {
      baseUrl: 'https://api.tidalhifi.com/v1',
      clientId: process.env.TIDAL_CLIENT_ID,
      clientSecret: process.env.TIDAL_CLIENT_SECRET,
    },
  }

  constructor(
    private prisma: PrismaService,
    private cache: CacheService,
    private logger: Logger,
  ) {}

  /**
   * Get playable track from multiple providers with fallback
   */
  async getPlayableTrack(songId: string, providers?: string[]): Promise<PlayableTrack> {
    const cacheKey = `playable_track:${songId}`
    const cached = await this.cache.get(cacheKey)

    if (cached) return cached

    const song = await this.prisma.song.findUnique({
      where: { id: songId },
    })

    if (!song) {
      throw new BadRequestException('Song not found')
    }

    const availableProviders = providers || Object.keys(this.providers)
    let playableTrack: PlayableTrack | null = null

    for (const provider of availableProviders) {
      try {
        playableTrack = await this.getTrackFromProvider(song, provider as keyof typeof this.providers)
        if (playableTrack) break
      } catch (error) {
        this.logger.warn(`Failed to get track from ${provider}: ${error.message}`)
        continue
      }
    }

    if (!playableTrack) {
      throw new BadRequestException('Track not available on any provider')
    }

    await this.cache.set(cacheKey, playableTrack, 3600) // Cache for 1 hour
    return playableTrack
  }

  private async getTrackFromProvider(song: any, provider: keyof typeof this.providers): Promise<PlayableTrack | null> {
    switch (provider) {
      case 'spotify':
        return this.getSpotifyTrack(song)
      case 'apple_music':
        return this.getAppleMusicTrack(song)
      case 'youtube_music':
        return this.getYouTubeMusicTrack(song)
      case 'soundcloud':
        return this.getSoundCloudTrack(song)
      case 'deezer':
        return this.getDeezerTrack(song)
      case 'tidal':
        return this.getTidalTrack(song)
      default:
        return null
    }
  }

  private async getSpotifyTrack(song: any): Promise<PlayableTrack | null> {
    try {
      const response = await axios.get(`${this.providers.spotify.baseUrl}/search`, {
        params: {
          q: `${song.title} ${song.artist?.name}`,
          type: 'track',
          limit: 1,
        },
        headers: this.providers.spotify.headers,
      })

      const track = response.data.tracks?.items[0]
      if (!track) return null

      return {
        id: track.id,
        title: track.name,
        artist: track.artists[0].name,
        provider: 'spotify',
        url: track.external_urls.spotify,
        duration: track.duration_ms,
      }
    } catch (error) {
      this.logger.error(`Spotify API error: ${error.message}`)
      return null
    }
  }

  private async getAppleMusicTrack(song: any): Promise<PlayableTrack | null> {
    try {
      const response = await axios.get(`${this.providers.apple_music.baseUrl}/us/search`, {
        params: {
          term: `${song.title} ${song.artist?.name}`,
          types: 'songs',
          limit: 1,
        },
        headers: {
          Authorization: `Bearer ${this.providers.apple_music.token}`,
        },
      })

      const track = response.data.results.songs?.data[0]
      if (!track) return null

      return {
        id: track.id,
        title: track.attributes.name,
        artist: track.attributes.artistName,
        provider: 'apple_music',
        url: track.attributes.url,
        duration: track.attributes.durationInMillis,
      }
    } catch (error) {
      this.logger.error(`Apple Music API error: ${error.message}`)
      return null
    }
  }

  private async getYouTubeMusicTrack(song: any): Promise<PlayableTrack | null> {
    try {
      const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
        params: {
          q: `${song.title} ${song.artist?.name}`,
          type: 'video',
          part: 'snippet',
          key: this.providers.youtube_music.apiKey,
          maxResults: 1,
        },
      })

      const video = response.data.items[0]
      if (!video) return null

      return {
        id: video.id.videoId,
        title: video.snippet.title,
        artist: video.snippet.channelTitle,
        provider: 'youtube_music',
        url: `https://www.youtube.com/watch?v=${video.id.videoId}`,
        duration: 0, // Would need additional API call
      }
    } catch (error) {
      this.logger.error(`YouTube Music API error: ${error.message}`)
      return null
    }
  }

  private async getSoundCloudTrack(song: any): Promise<PlayableTrack | null> {
    try {
      const response = await axios.get(`${this.providers.soundcloud.baseUrl}/tracks`, {
        params: {
          q: `${song.title} ${song.artist?.name}`,
          client_id: this.providers.soundcloud.clientId,
          limit: 1,
        },
      })

      const track = response.data[0]
      if (!track) return null

      return {
        id: track.id,
        title: track.title,
        artist: track.user.username,
        provider: 'soundcloud',
        url: track.permalink_url,
        duration: track.duration,
      }
    } catch (error) {
      this.logger.error(`SoundCloud API error: ${error.message}`)
      return null
    }
  }

  private async getDeezerTrack(song: any): Promise<PlayableTrack | null> {
    try {
      const response = await axios.get(`${this.providers.deezer.baseUrl}/search`, {
        params: {
          q: `${song.title} ${song.artist?.name}`,
          limit: 1,
        },
      })

      const track = response.data.data[0]
      if (!track) return null

      return {
        id: track.id,
        title: track.title,
        artist: track.artist.name,
        provider: 'deezer',
        url: track.link,
        duration: track.duration * 1000,
      }
    } catch (error) {
      this.logger.error(`Deezer API error: ${error.message}`)
      return null
    }
  }

  private async getTidalTrack(song: any): Promise<PlayableTrack | null> {
    try {
      const response = await axios.get(`${this.providers.tidal.baseUrl}/search/tracks`, {
        params: {
          query: `${song.title} ${song.artist?.name}`,
          clientId: this.providers.tidal.clientId,
          limit: 1,
        },
      })

      const track = response.data.items[0]
      if (!track) return null

      return {
        id: track.id,
        title: track.title,
        artist: track.artists[0].name,
        provider: 'tidal',
        url: `https://tidal.com/browse/track/${track.id}`,
        duration: track.duration * 1000,
      }
    } catch (error) {
      this.logger.error(`Tidal API error: ${error.message}`)
      return null
    }
  }

  /**
   * Search across all providers
   */
  async searchMultiProvider(query: string, type: 'track' | 'artist' | 'album' = 'track') {
    const results = await Promise.allSettled([
      this.searchSpotify(query, type),
      this.searchAppleMusic(query, type),
      this.searchYouTubeMusic(query, type),
    ])

    return results
      .filter((r) => r.status === 'fulfilled')
      .map((r) => (r as PromiseFulfilledResult<any>).value)
      .flat()
  }

  private async searchSpotify(query: string, type: string) {
    // Spotify search implementation
    return []
  }

  private async searchAppleMusic(query: string, type: string) {
    // Apple Music search implementation
    return []
  }

  private async searchYouTubeMusic(query: string, type: string) {
    // YouTube Music search implementation
    return []
  }

  /**
   * Get user's listening history
   */
  async recordListeningHistory(userId: string, songId: string, duration: number, completed: boolean) {
    return this.prisma.listeningHistory.create({
      data: {
        userId,
        songId,
        duration,
        completed,
        platform: 'universal_music_hub',
        createdAt: new Date(),
      },
    })
  }
}
