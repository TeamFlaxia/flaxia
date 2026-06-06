import type { Metadata } from 'next';
import fs from 'fs';
import path from 'path';
import { LegalContent } from '@/components/LegalContent';

export const metadata: Metadata = {
  title: 'Whitepaper - Flaxia',
  description: 'Flaxia Whitepaper',
};

async function getContent(locale: string): Promise<string> {
  const filePath = path.join(process.cwd(), 'public', 'legal', `whitepaper.${locale}.md`);
  const fallback = path.join(process.cwd(), 'public', 'legal', 'whitepaper.en.md');
  try {
    return fs.readFileSync(fs.existsSync(filePath) ? filePath : fallback, 'utf-8');
  } catch {
    return 'Content not available.';
  }
}

export default async function WhitepaperPage() {
  const content = await getContent('en');
  return <LegalContent type="whitepaper" content={content} title="Flaxia Whitepaper" />;
}
