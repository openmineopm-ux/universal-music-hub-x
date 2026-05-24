import { Injectable, BadRequestException } from '@nestjs/common'
import { PrismaService } from '../database/prisma.service'
import { CacheService } from '../cache/cache.service'
import { Logger } from '../common/logger/logger.service'
import axios from 'axios'

export interface PlaylistGenerationRequest {
  userId: string
  mood?: string
  genre?: string
  activity?: string
  duration?: number // in minutes
  bpmRange?: { min: number; max: number }
  energyLevel?: 'low' | 'medium' | 'high'
  temperature?: number // weather
}

@Injectable()
export class PlaylistGeneratorService {
  private openaiApiKey = process.env.OPENAI_API_KEY
  private anthropicApiKey = process.env.ANTHROPIC_API_KEY

  constructor(
    private prisma: PrismaService,
    private cache: CacheService,
    private logger: Logger,
  ) {}

  /**
   * Generate AI-powered playlist based on multiple parameters
   */
  async generatePlaylist(request: PlaylistGenerationRequest): Promise<any> {
    try {
      const cacheKey = `playlist:${request.userId}:${JSON.stringify(request)}`
      const cached = await this.cache.get(cacheKey)
      if (cached) return cached

      // Get user's listening history for context
      const userContext = await this.getUserContext(request.userId)

      // Determine mood context
      const moodContext = request.mood || this.detectMoodFromTime(new Date())

      // Get songs matching criteria
      const songs = await this.getSongsForPlaylist({
        mood: moodContext,
        genre: request.genre,
        energyLevel: request.energyLevel,
        bpmRange: request.bpmRange,
        userHistory: userContext.listeningHistory,
        maxDuration: request.duration,
      })

      // Use AI to order songs for smooth transitions and flow
      const orderedSongs = await this.orderSongsWithAI(songs, {
        mood: moodContext,
        activity: request.activity,
      })

      // Create playlist
      const playlist = await this.prisma.playlist.create({
        data: {
          name: this.generatePlaylistName(moodContext, request.activity),
          description: this.generatePlaylistDescription(moodContext, request.genre, request.activity),
          ownerId: request.userId,
          generatedByAi: true,
          aiMood: moodContext,
          aiGenre: request.genre,
          isPublic: false,
          songs: {
            connect: orderedSongs.map((s) => ({ id: s.id })),
          },
        },
        include: {
          songs: {
            include: { artist: true, album: true },
          },
        },
      })

      await this.cache.set(cacheKey, playlist, 3600)
      return playlist
    } catch (error) {
      this.logger.error(`Playlist generation error: ${error.message}`)
      throw new BadRequestException('Failed to generate playlist')
    }
  }

  /**
   * Get user context for better personalization
   */
  private async getUserContext(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        listeningHistory: {
          orderBy: { createdAt: 'desc' },
          take: 100,
          include: { song: { include: { artist: true } } },
        },
      },
    })

    return {
      user,
      listeningHistory: user?.listeningHistory || [],
      favoriteGenres: this.extractGenresFromHistory(user?.listeningHistory || []),
      averageEnergy: this.calculateAverageEnergy(user?.listeningHistory || []),
    }
  }

  /**
   * Get songs matching playlist criteria
   */
  private async getSongsForPlaylist(criteria: {
    mood: string
    genre?: string
    energyLevel?: string
    bpmRange?: { min: number; max: number }
    userHistory: any[]
    maxDuration?: number
  }): Promise<any[]> {
    let query: any = {
      mood: criteria.mood,
    }

    // Filter by genre if specified
    if (criteria.genre) {
      query.genres = {
        hasSome: [criteria.genre],
      }
    }

    // Filter by energy level
    if (criteria.energyLevel) {
      const energyRange = this.getEnergyRange(criteria.energyLevel)
      query.energy = {
        gte: energyRange.min,
        lte: energyRange.max,
      }
    }

    // Filter by BPM range
    if (criteria.bpmRange) {
      query.bpm = {
        gte: criteria.bpmRange.min,
        lte: criteria.bpmRange.max,
      }
    }

    // Get songs
    let songs = await this.prisma.song.findMany({
      where: query,
      take: 500,
      include: { artist: true },
    })

    // Calculate total duration and trim if needed
    if (criteria.maxDuration) {
      const maxDurationMs = criteria.maxDuration * 60 * 1000
      let totalDuration = 0
      const selectedSongs = []

      for (const song of songs) {
        if (totalDuration + song.duration <= maxDurationMs) {
          selectedSongs.push(song)
          totalDuration += song.duration
        } else {
          break
        }
      }

      return selectedSongs
    }

    return songs.slice(0, 50)
  }

  /**
   * Use AI to order songs for optimal listening experience
   */
  private async orderSongsWithAI(
    songs: any[],
    context: { mood: string; activity?: string },
  ): Promise<any[]> {
    try {
      if (!this.openaiApiKey) {
        // Fallback: Order by BPM for smooth transitions
        return this.orderSongsByBPM(songs)
      }

      const songList = songs.map((s) => `${s.title} by ${s.artist.name} (BPM: ${s.bpm}, Energy: ${s.energy})`).join('\n')

      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4',
          messages: [
            {
              role: 'system',
              content:
                'You are a music curator. Create the perfect song order for a playlist with smooth transitions. Consider BPM, energy, and mood progression. Return ONLY a JSON array of song titles in order.',
            },
            {
              role: 'user',
              content: `Create playlist order for ${context.mood} mood${context.activity ? ` (${context.activity})` : ''}:\n${songList}`,
            },
          ],
          temperature: 0.7,
        },
        {
          headers: {
            Authorization: `Bearer ${this.openaiApiKey}`,
          },
        },
      )

      const orderedTitles = JSON.parse(response.data.choices[0].message.content)
      const titleMap = Object.fromEntries(songs.map((s) => [`${s.title} by ${s.artist.name}`, s]))

      return orderedTitles.map((title: string) => titleMap[title] || titleMap[Object.keys(titleMap)[0]])
    } catch (error) {
      this.logger.warn(`AI ordering failed, using BPM fallback: ${error.message}`)
      return this.orderSongsByBPM(songs)
    }
  }

  /**
   * Fallback: Order songs by BPM for smooth transitions
   */
  private orderSongsByBPM(songs: any[]): any[] {
    const sorted = [...songs].sort((a, b) => (a.bpm || 0) - (b.bpm || 0))

    // Create smooth transitions
    const ordered: any[] = []
    const used = new Set<string>()

    // Start with mid-range BPM song
    const startIdx = Math.floor(sorted.length / 2)
    ordered.push(sorted[startIdx])
    used.add(sorted[startIdx].id)

    // Alternate between lower and higher BPM
    for (let i = 1; i < sorted.length; i++) {
      const lowIdx = startIdx - Math.ceil(i / 2)
      const highIdx = startIdx + Math.ceil(i / 2)

      if (lowIdx >= 0 && !used.has(sorted[lowIdx].id)) {
        ordered.push(sorted[lowIdx])
        used.add(sorted[lowIdx].id)
      }

      if (highIdx < sorted.length && !used.has(sorted[highIdx].id)) {
        ordered.push(sorted[highIdx])
        used.add(sorted[highIdx].id)
      }
    }

    return ordered
  }

  /**
   * Detect mood from current time of day
   */
  private detectMoodFromTime(date: Date): string {
    const hour = date.getHours()

    if (hour >= 5 && hour < 12) return 'energetic' // Morning
    if (hour >= 12 && hour < 17) return 'focused' // Afternoon
    if (hour >= 17 && hour < 21) return 'relaxed' // Evening
    return 'peaceful' // Night
  }

  /**
   * Extract favorite genres from listening history
   */
  private extractGenresFromHistory(history: any[]): string[] {
    const genreMap: Record<string, number> = {}

    for (const entry of history) {
      if (entry.song.genres) {
        const genres = typeof entry.song.genres === 'string' ? JSON.parse(entry.song.genres) : entry.song.genres

        for (const genre of genres) {
          genreMap[genre] = (genreMap[genre] || 0) + 1
        }
      }
    }

    return Object.entries(genreMap)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([genre]) => genre)
  }

  /**
   * Calculate average energy from listening history
   */
  private calculateAverageEnergy(history: any[]): number {
    if (history.length === 0) return 0.5

    const totalEnergy = history.reduce((sum, entry) => sum + (entry.song.energy || 0.5), 0)
    return totalEnergy / history.length
  }

  /**
   * Get energy range for energy level
   */
  private getEnergyRange(level: string): { min: number; max: number } {
    switch (level) {
      case 'low':
        return { min: 0, max: 0.33 }
      case 'medium':
        return { min: 0.33, max: 0.66 }
      case 'high':
        return { min: 0.66, max: 1 }
      default:
        return { min: 0, max: 1 }
    }
  }

  /**
   * Generate creative playlist name
   */
  private generatePlaylistName(mood: string, activity?: string): string {
    const names: Record<string, string[]> = {
      energetic: ['Power Hour', 'Peak Energy', 'Go Time', 'Maximum Vibes'],
      focused: ['Deep Focus', 'Flow State', 'Concentration Zone', 'Mind On'],
      relaxed: ['Chill Vibes', 'Easy Listening', 'Unwind Time', 'Mellow Moments'],
      peaceful: ['Zen Night', 'Sleep Sounds', 'Dreamy Night', 'Sweet Dreams'],
      happy: ['Good Feelings', 'Feel Good Mix', 'Positivity Boost', 'Happiness Songs'],
      sad: ['Emotional Journey', 'Reflective Moments', 'Deep Feels', 'Soul Search'],
    }

    const moodNames = names[mood] || ['AI Generated Mix']
    const name = moodNames[Math.floor(Math.random() * moodNames.length)]

    return activity ? `${name} - ${activity}` : name
  }

  /**
   * Generate creative playlist description
   */
  private generatePlaylistDescription(mood: string, genre?: string, activity?: string): string {
    const moodEmojis: Record<string, string> = {
      energetic: '⚡ Get pumped with high-energy tracks',
      focused: '🎯 Stay concentrated with focus-friendly music',
      relaxed: '😎 Unwind with smooth, chill vibes',
      peaceful: '🌙 Drift away with peaceful sounds',
      happy: '😊 Boost your mood with feel-good songs',
      sad: '💙 Express emotions with soulful tracks',
    }

    const description = moodEmojis[mood] || '🎵 Curated just for you'
    return `${description}${genre ? ` | ${genre}` : ''}${activity ? ` | Perfect for ${activity}` : ''}`
  }

  /**
   * Regenerate playlist with different songs
   */
  async regeneratePlaylist(playlistId: string): Promise<any> {
    const playlist = await this.prisma.playlist.findUnique({
      where: { id: playlistId },
      include: { songs: true },
    })

    if (!playlist) {
      throw new BadRequestException('Playlist not found')
    }

    // Generate new playlist with same parameters
    return this.generatePlaylist({
      userId: playlist.ownerId,
      mood: playlist.aiMood,
      genre: playlist.aiGenre,
    })
  }
}
