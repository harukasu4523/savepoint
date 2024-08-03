'use server'

import pgvector from 'pgvector'
import { randomUUID } from 'crypto'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { openai } from '@ai-sdk/openai'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { fromCognitoIdentityPool } from '@aws-sdk/credential-providers'
import { PrismaClient } from '@prisma/client'
import { generateFilesObjectAgent, streamSummaryTextAgent } from './_agent/agents'
import { documentsLoader, imagesLoader } from './_agent/loader'
import { auth } from '../../auth'

const prisma = new PrismaClient()
const s3Client = new S3Client({
  region: process.env.AWS_BUCKET_REGION,
  credentials: fromCognitoIdentityPool({
    clientConfig: { region: process.env.AWS_BUCKET_REGION },
    identityPoolId: process.env.AWS_IDENTITY_POOL_ID as string,
  }),
})

// ファイルからdescriptionの生成
export const confirmAction = async (
  formData: FormData,
  webkitRelativePaths: string[],
) => {
  // 重要なファイルをピックアップ
  const paths = await generateFilesObjectAgent(webkitRelativePaths)
  const formFiles = formData.getAll('files') as File[]
  const files = formFiles
    .map((file, i) => {
      // formFileにwebkitRelativePathが含まれないため手動で追加
      const webkitRelativePath = webkitRelativePaths[i]
      return Object.assign(file, { webkitRelativePath })  // readonlyを上書き
    })
    .filter((file) => {
      // 重要なファイルのformFileのみを取得
      return paths.includes(file.webkitRelativePath)
    })

  // ファイルの読み込み
  const text = await documentsLoader(files)
  const images = await imagesLoader(files)

  // ファイルからプロジェクト概要を生成
  const summaryStream = await streamSummaryTextAgent(text, images)
  return summaryStream
}

// ProjectのDBへの保存・ファイルのS3へのアップロード
export const saveAction = async (prevState: any, formData: FormData) => {
  // フォームの取得
  const name = formData.get('name')?.toString() ?? ''
  const message = formData.get('description')?.toString() ?? ''
  const files = formData.getAll('files') as File[]

  // バリデーション
  if (!name.length) {
    return {
      status: false,
      message: 'プロジェク名は1文字以上の長さにしてください。'
    }
  }

  try {
    // ペイロード
    const id = randomUUID()
    const description = `# ${name}

${message}
`
  
    // エンべディング
    const response = await openai.embeddings.create({
      input: description,
      model: 'text-embedding-ada-002',
    })

    // Projectのインサート
    const embedding = pgvector.toSql(response.data[0].embedding)
    const result: number = await prisma.$executeRaw`
INSERT INTO
  public."Project" (
    id,
    name,
    description,
    embedding
  ) VALUES (
    ${id},
    ${name},
    ${description},
    ${embedding}::vector
  )
`

    // projectUserのインサート
    const session = await auth()
    const userId = session?.user?.id
    if (!userId) {
      throw new Error('Failed to add role: User ID is null or undefined')
    }

    await prisma.projectUser.create({
      data: {
        userId: userId,
        projectId: id,
        role: 'OWNER',
      },
    }) 

    // ファイルのアップロード
    const dirKey = `projects/${id}/`
    for (const file of files) {
      const fileBuffer = await file.arrayBuffer()
      const fileKey = `${dirKey}${file.name}`
      await s3Client.send(new PutObjectCommand({
        Bucket: process.env.AWS_BUCKET_NAME_RAW,
        Key: fileKey,
        Body: Buffer.from(fileBuffer),
      }))
    }
  } catch (error) {
    console.log({error})
    return {
      status: false,
      message: '内部エラーが発生しました。開発者にお問合せください。'
    }
  } finally {
    await prisma.$disconnect()
  }

  revalidatePath('/projects')
  redirect('/projects')
  return {
    status: true,
    data: {},
  }
}
