import { Injectable } from '@nestjs/common'
import { PrismaService } from '../database/prisma.service'
import { CacheService } from '../cache/cache.service'
import { Logger } from '../common/logger/logger.service'
import axios from 'axios'

export interface RecommendationResult {
  songId: string
  score: number
  reason: string
  source: 'collaborative' | 'content_based' | 'mood_based' | 'trending'
}

@Injectable()
export class RecommendationService {
  private openaiApiKey = process.env.OPENAI_API_KEY
  private anthropicApiKey = process.env.ANTHROPIC_API_KEY

  constructor(
    private prisma: PrismaService,
    private cache: CacheService,
    private logger: Logger,
  ) {}

  /**
   * Generate personalized recommendations using multiple algorithms
   */
  async getRecommendations(userId: string, limit: number = 20): Promise<RecommendationResult[]> {
    const cacheKey = `recommendations:${userId}`
    const cached = await this.cache.get(cacheKey)
    if (cached) return cached

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { listeningHistory: { take: 100 } },
    })

    if (!user) throw new Error('User not found')

    // Run multiple recommendation algorithms in parallel
    const [collaborative, contentBased, moodBased, trending] = await Promise.all([
      this.collaborativeFiltering(userId, limit),
      this.contentBasedFiltering(userId, limit),
      this.moodBasedRecommendations(userId, limit),
      this.trendingRecommendations(limit),
    ])

    // Merge and score recommendations
    const recommendations = this.mergeRecommendations([
      ...collaborative.map((r) => ({ ...r, source: 'collaborative' as const })),
      ...contentBased.map((r) => ({ ...r, source: 'content_based' as const })),
      ...moodBased.map((r) => ({ ...r, source: 'mood_based' as const })),
      ...trending.map((r) => ({ ...r, source: 'trending' as const })),
    ])

    // Save recommendations to database
    for (const rec of recommendations.slice(0, limit)) {
      await this.prisma.recommendation.create({
        data: {
          userId,
          songId: rec.songId,
          score: rec.score,
          reason: rec.reason,
          source: rec.source,
          algorithmVersion: '1.0.0',
        },
      })
    }

    const results = recommendations.slice(0, limit)
    await this.cache.set(cacheKey, results, 3600) // Cache for 1 hour
    return results
  }

  /**
   * Collaborative Filtering - Find similar users and their liked songs
   */
  private async collaborativeFiltering(userId: string, limit: number): Promise<RecommendationResult[]> {
    try {
      // Get user's listening history
      const userHistory = await this.prisma.listeningHistory.findMany({
        where: { userId },
        include: { song: true },
        take: 50,
      })

      const likedSongs = userHistory.map((h) => h.songId)

      // Find similar users (users who liked same songs)
      const similarUsers = await this.prisma.listeningHistory.groupBy({
        by: ['userId'],
        where: {
          songId: { in: likedSongs },
          userId: { not: userId },
        },
        _count: { songId: true },
        orderBy: { _count: { songId: 'desc' } },
        take: 10,
      })

      // Get songs from similar users that current user hasn't heard
      const similarUserIds = similarUsers.map((u) => u.userId)
      const recommendations = await this.prisma.listeningHistory.findMany({
        where: {
          userId: { in: similarUserIds },
          songId: { notIn: likedSongs },
        },
        include: { song: true },
        take: limit,
      })

      return recommendations.map((r, idx) => ({
        songId: r.songId,
        score: 0.8 - idx * 0.02,
        reason: 'Users who liked your songs also enjoyed this',
        source: 'collaborative' as const,
      }))
    } catch (error) {
      this.logger.error(`Collaborative filtering error: ${error.message}`)
      return []
    }
  }

  /**
   * Content-Based Filtering - Find songs similar to liked songs
   */
  private async contentBasedFiltering(userId: string, limit: number): Promise<RecommendationResult[]> {
    try {
      const likedSongs = await this.prisma.song.findMany({
        where: {
          likedByUsers: { some: { id: userId } },
        },
        take: 10,
      })

      if (likedSongs.length === 0) return []

      // Calculate average audio features of liked songs
      const avgFeatures = {
        energy: likedSongs.reduce((sum, s) => sum + (s.energy || 0), 0) / likedSongs.length,
        danceability: likedSongs.reduce((sum, s) => sum + (s.danceability || 0), 0) / likedSongs.length,
        valence: likedSongs.reduce((sum, s) => sum + (s.valence || 0), 0) / likedSongs.length,
        acousticness: likedSongs.reduce((sum, s) => sum + (s.acousticness || 0), 0) / likedSongs.length,
      }

      // Find songs with similar audio features
      const likedSongIds = likedSongs.map((s) => s.id)
      const allSongs = await this.prisma.song.findMany({
        where: { id: { notIn: likedSongIds } },
        take: limit * 2,
      })

      // Score songs based on audio feature similarity
      const scored = allSongs.map((song) => ({
        song,
        similarity: this.calculateAudioSimilarity(song, avgFeatures),
      }))

      return scored
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit)
        .map((item, idx) => ({
          songId: item.song.id,
          score: item.similarity,
          reason: `Similar to songs you like (${item.song.mood || 'various'} mood)`,
          source: 'content_based' as const,
        }))
    } catch (error) {
      this.logger.error(`Content-based filtering error: ${error.message}`)
      return []
    }
  }

  /**
   * Mood-Based Recommendations - Use AI to detect mood and recommend accordingly
   */
  private async moodBasedRecommendations(userId: string, limit: number): Promise<RecommendationResult[]> {
    try {
      // Get user's recent listening history
      const recentHistory = await this.prisma.listeningHistory.findMany({
        where: { userId },
        include: { song: true },
        orderBy: { createdAt: 'desc' },
        take: 20,
      })

      if (recentHistory.length === 0) return []

      // Analyze listening patterns to detect mood
      const detectedMood = this.detectMoodFromHistory(recentHistory)

      // Get songs matching the detected mood
      const recommendations = await this.prisma.song.findMany({
        where: {
          mood: detectedMood,
          likedByUsers: { none: { id: userId } },
        },
        take: limit,
      })

      return recommendations.map((song, idx) => ({
        songId: song.id,
        score: 0.85 - idx * 0.01,
        reason: `Perfect for your ${detectedMood} mood`,
        source: 'mood_based' as const,
      }))
    } catch (error) {
      this.logger.error(`Mood-based recommendation error: ${error.message}`)
      return []
    }
  }

  /**
   * Trending Recommendations - Get popular songs that user hasn't heard
   */
  private async trendingRecommendations(limit: number): Promise<RecommendationResult[]> {
    try {
      const trending = await this.prisma.song.findMany({
        orderBy: { playCount: 'desc' },
        take: limit,
      })

      return trending.map((song, idx) => ({
        songId: song.id,
        score: 0.7 - idx * 0.01,
        reason: 'Trending now',
        source: 'trending' as const,
      }))
    } catch (error) {
      this.logger.error(`Trending recommendation error: ${error.message}`)
      return []
    }
  }

  /**
   * Calculate similarity between two audio profiles
   */
  private calculateAudioSimilarity(
    song: any,
    targetFeatures: {
      energy: number
      danceability: number
      valence: number
      acousticness: number
    },
  ): number {
    const euclideanDistance = Math.sqrt(
      Math.pow((song.energy || 0) - targetFeatures.energy, 2) +
        Math.pow((song.danceability || 0) - targetFeatures.danceability, 2) +
        Math.pow((song.valence || 0) - targetFeatures.valence, 2) +
        Math.pow((song.acousticness || 0) - targetFeatures.acousticness, 2),
    )

    // Convert distance to similarity score (0-1)
    return 1 / (1 + euclideanDistance)
  }

  /**
   * Detect mood from listening history
   */
  private detectMoodFromHistory(
    history: Array<{ song: any; duration: number; completed: boolean }>,
  ): string {
    const moods = history.map((h) => h.song.mood).filter(Boolean)
    const moodCounts = moods.reduce((acc: Record<string, number>, mood) => {
      acc[mood] = (acc[mood] || 0) + 1
      return acc
    }, {})

    const mostCommonMood = Object.keys(moodCounts).sort((a, b) => moodCounts[b] - moodCounts[a])[0]
    return mostCommonMood || 'neutral'
  }

  /**
   * Merge multiple recommendation lists and score them
   */
  private mergeRecommendations(recommendations: RecommendationResult[]): RecommendationResult[] {
    const merged: Record<string, RecommendationResult> = {}

    for (const rec of recommendations) {
      if (merged[rec.songId]) {
        // Average scores from multiple algorithms
        merged[rec.songId].score = (merged[rec.songId].score + rec.score) / 2
        merged[rec.songId].reason += ` + ${rec.reason}`
      } else {
        merged[rec.songId] = rec
      }
    }

    return Object.values(merged).sort((a, b) => b.score - a.score)
  }

  /**
   * Get AI-powered recommendations using LLM
   */
  async getAIEnhancedRecommendations(userId: string, userPreferences: string): Promise<RecommendationResult[]> {
    try {
      const userHistory = await this.prisma.listeningHistory.findMany({
        where: { userId },
        include: { song: { include: { artist: true } } },
        take: 20,
      })

      const listeningContext = userHistory
        .map((h) => `${h.song.title} by ${h.song.artist?.name}`)
        .join(', ')

      // Call OpenAI for intelligent recommendations
      if (this.openaiApiKey) {
        const response = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: 'gpt-4',
            messages: [
              {
                role: 'system',
                content:
                  'You are a music recommendation expert. Based on listening history and preferences, recommend songs.',
              },
              {
                role: 'user',
                content: `User listens to: ${listeningContext}\n\nPreferences: ${userPreferences}\n\nRecommend 10 songs in JSON format: [{title: string, artist: string, reason: string}]`,
              },
            ],
          },
          {
            headers: {
              Authorization: `Bearer ${this.openaiApiKey}`,
            },
          },
        )

        const recommendations = JSON.parse(response.data.choices[0].message.content)
        return recommendations.map((rec: any, idx: number) => ({
          songId: rec.id || `ai-rec-${idx}`,
          score: 0.9 - idx * 0.02,
          reason: rec.reason,
          source: 'content_based' as const,
        }))
      }

      return []
    } catch (error) {
      this.logger.error(`AI recommendation error: ${error.message}`)
      return []
    }
  }
}
