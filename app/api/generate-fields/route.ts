import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { FieldGenerationResponse } from '@/lib/types/field-generation';

export async function POST(request: NextRequest) {
  try {
    const { prompt } = await request.json();

    if (!prompt || typeof prompt !== 'string') {
      return NextResponse.json(
        { error: 'Prompt is required' },
        { status: 400 }
      );
    }

    if (!process.env.AI_GATEWAY_API_KEY) {
      return NextResponse.json(
        { error: 'AI Gateway API key not configured' },
        { status: 500 }
      );
    }

    const openai = new OpenAI({
      baseURL: 'https://ai-gateway.vercel.sh/v1',
      apiKey: process.env.AI_GATEWAY_API_KEY,
    });

    const completion = await openai.chat.completions.create({
      model: 'openai/gpt-5',
      messages: [
        {
          role: 'system',
          content: `You are an expert at understanding data enrichment needs and converting natural language requests into structured field definitions.
          
          When the user describes what data they want to collect about companies, extract each distinct piece of information as a separate field.
          
          Guidelines:
          - Use clear, professional field names (e.g., "Company Size" not "size")
          - Provide helpful descriptions that explain what data should be found
          - Choose appropriate data types:
            - string: for text, URLs, descriptions
            - number: for counts, amounts, years
            - boolean: for yes/no questions
            - array: for lists of items
          - Include example values when helpful
          - Common fields include: Company Name, Description, Industry, Employee Count, Founded Year, Headquarters Location, Website, Funding Amount, etc.`
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'field_generation',
          strict: true,
          schema: zodResponseFormat(FieldGenerationResponse, 'field_generation').json_schema.schema
        }
      }
    });

    const message = completion.choices[0].message;
    
    if (!message.content) {
      throw new Error('No response content');
    }
    
    const parsed = JSON.parse(message.content) as z.infer<typeof FieldGenerationResponse>;

    return NextResponse.json({
      success: true,
      data: parsed,
    });
  } catch (error) {
    console.error('Field generation error:', error);
    return NextResponse.json(
      { error: 'Failed to generate fields' },
      { status: 500 }
    );
  }
}