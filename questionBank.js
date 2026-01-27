// ============================================
// 📝 QUESTION BANK - 40+ SETS (200+ QUESTIONS)
// ============================================
// Each set = 5 questions
// Mix of types: choice, scale, yesno
// Focused on: How alive/well the user feels
// ============================================

const QUESTION_SETS = [
  // ============================================
  // SET 1-10: DAILY BASICS
  // ============================================
  
  // Set 1 - Morning Vibes
  [
    {
      id: 'q1_1',
      text: 'How did you sleep last night?',
      type: 'choice',
      options: ['Terrible', 'Okay', 'Amazing']
    },
    {
      id: 'q1_2',
      text: 'Energy level right now?',
      type: 'choice',
      options: ['Drained', 'Meh', 'Buzzing']
    },
    {
      id: 'q1_3',
      text: 'How do you feel about today?',
      type: 'choice',
      options: ['Dreading it', 'Neutral', 'Excited']
    },
    {
      id: 'q1_4',
      text: 'Did you eat something today?',
      type: 'yesno'
    },
    {
      id: 'q1_5',
      text: 'Have you talked to anyone today?',
      type: 'yesno'
    }
  ],

  // Set 2 - Mental State
  [
    {
      id: 'q2_1',
      text: 'How clear is your mind today?',
      type: 'scale',
      min: 1,
      max: 5,
      labels: ['Foggy', 'Crystal Clear']
    },
    {
      id: 'q2_2',
      text: 'Stress level right now?',
      type: 'scale',
      min: 1,
      max: 5,
      labels: ['Chill', 'Overwhelmed']
    },
    {
      id: 'q2_3',
      text: 'Can you focus on tasks today?',
      type: 'choice',
      options: ['Not at all', 'Struggling', 'Totally']
    },
    {
      id: 'q2_4',
      text: 'Did you laugh or smile today?',
      type: 'yesno'
    },
    {
      id: 'q2_5',
      text: 'Do you feel like yourself today?',
      type: 'yesno'
    }
  ],

  // Set 3 - Physical Body
  [
    {
      id: 'q3_1',
      text: 'How does your body feel?',
      type: 'choice',
      options: ['Awful', 'Tired', 'Good', 'Great']
    },
    {
      id: 'q3_2',
      text: 'Did you move your body today?',
      type: 'yesno'
    },
    {
      id: 'q3_3',
      text: 'Any pain or discomfort?',
      type: 'choice',
      options: ['A lot', 'A little', 'None']
    },
    {
      id: 'q3_4',
      text: 'How hydrated do you feel?',
      type: 'choice',
      options: ['Dehydrated', 'Okay', 'Well hydrated']
    },
    {
      id: 'q3_5',
      text: 'Did you spend time outside today?',
      type: 'yesno'
    }
  ],

  // Set 4 - Emotional Vibe
  [
    {
      id: 'q4_1',
      text: 'How are you feeling emotionally?',
      type: 'choice',
      options: ['Down', 'Flat', 'Neutral', 'Good', 'Amazing']
    },
    {
      id: 'q4_2',
      text: 'Did anything make you happy today?',
      type: 'yesno'
    },
    {
      id: 'q4_3',
      text: 'Are you worried about something?',
      type: 'yesno'
    },
    {
      id: 'q4_4',
      text: 'How connected do you feel to others?',
      type: 'scale',
      min: 1,
      max: 5,
      labels: ['Alone', 'Connected']
    },
    {
      id: 'q4_5',
      text: 'Do you feel appreciated?',
      type: 'yesno'
    }
  ],

  // Set 5 - Social Energy
  [
    {
      id: 'q5_1',
      text: 'Did you connect with someone meaningful today?',
      type: 'yesno'
    },
    {
      id: 'q5_2',
      text: 'How much social energy do you have?',
      type: 'choice',
      options: ['Zero', 'Low', 'Medium', 'High']
    },
    {
      id: 'q5_3',
      text: 'Do you want to be around people right now?',
      type: 'yesno'
    },
    {
      id: 'q5_4',
      text: 'Did you text/call someone you care about?',
      type: 'yesno'
    },
    {
      id: 'q5_5',
      text: 'Do you feel heard by others?',
      type: 'yesno'
    }
  ],

  // Set 6 - Productivity & Purpose
  [
    {
      id: 'q6_1',
      text: 'Did you accomplish anything today?',
      type: 'yesno'
    },
    {
      id: 'q6_2',
      text: 'Do you feel productive?',
      type: 'choice',
      options: ['Not at all', 'A little', 'Very']
    },
    {
      id: 'q6_3',
      text: 'Are you motivated right now?',
      type: 'scale',
      min: 1,
      max: 5,
      labels: ['Zero motivation', 'Super motivated']
    },
    {
      id: 'q6_4',
      text: 'Do you have something to look forward to?',
      type: 'yesno'
    },
    {
      id: 'q6_5',
      text: 'Does today feel meaningful?',
      type: 'yesno'
    }
  ],

  // Set 7 - Self Care
  [
    {
      id: 'q7_1',
      text: 'Did you do something nice for yourself today?',
      type: 'yesno'
    },
    {
      id: 'q7_2',
      text: 'How well are you taking care of yourself?',
      type: 'scale',
      min: 1,
      max: 5,
      labels: ['Neglecting myself', 'Taking great care']
    },
    {
      id: 'q7_3',
      text: 'Did you take any breaks today?',
      type: 'yesno'
    },
    {
      id: 'q7_4',
      text: 'Are you being kind to yourself?',
      type: 'yesno'
    },
    {
      id: 'q7_5',
      text: 'Screen time today feels...',
      type: 'choice',
      options: ['Too much', 'Balanced', 'Too little']
    }
  ],

  // Set 8 - Quick Mood Check
  [
    {
      id: 'q8_1',
      text: 'Right now, I feel...',
      type: 'choice',
      options: ['Terrible', 'Bad', 'Okay', 'Good', 'Great']
    },
    {
      id: 'q8_2',
      text: 'My mood has been...',
      type: 'choice',
      options: ['Getting worse', 'Same', 'Getting better']
    },
    {
      id: 'q8_3',
      text: 'Did you cry today?',
      type: 'yesno'
    },
    {
      id: 'q8_4',
      text: 'Do you feel hopeful?',
      type: 'yesno'
    },
    {
      id: 'q8_5',
      text: 'Are you at peace right now?',
      type: 'yesno'
    }
  ],

  // Set 9 - Morning Energy
  [
    {
      id: 'q9_1',
      text: 'Did you wake up naturally or forced?',
      type: 'choice',
      options: ['Forced awake', 'Naturally']
    },
    {
      id: 'q9_2',
      text: 'Morning mood check:',
      type: 'choice',
      options: ['Grumpy', 'Neutral', 'Happy']
    },
    {
      id: 'q9_3',
      text: 'Did you snooze your alarm?',
      type: 'yesno'
    },
    {
      id: 'q9_4',
      text: 'How rested do you feel?',
      type: 'scale',
      min: 1,
      max: 5,
      labels: ['Exhausted', 'Fully rested']
    },
    {
      id: 'q9_5',
      text: 'Ready to take on the day?',
      type: 'yesno'
    }
  ],

  // Set 10 - Night Reflection
  [
    {
      id: 'q10_1',
      text: 'How was your day overall?',
      type: 'choice',
      options: ['Rough', 'Okay', 'Good', 'Amazing']
    },
    {
      id: 'q10_2',
      text: 'Did you do something you enjoyed today?',
      type: 'yesno'
    },
    {
      id: 'q10_3',
      text: 'Are you proud of yourself today?',
      type: 'yesno'
    },
    {
      id: 'q10_4',
      text: 'How tired are you right now?',
      type: 'scale',
      min: 1,
      max: 5,
      labels: ['Wide awake', 'Exhausted']
    },
    {
      id: 'q10_5',
      text: 'Do you feel grateful for anything today?',
      type: 'yesno'
    }
  ],

  // ============================================
  // SET 11-20: DEEPER WELLNESS
  // ============================================

  // Set 11 - Appetite & Nutrition
  [
    {
      id: 'q11_1',
      text: 'How is your appetite?',
      type: 'choice',
      options: ['No appetite', 'Normal', 'Very hungry']
    },
    {
      id: 'q11_2',
      text: 'Did you eat healthy food today?',
      type: 'yesno'
    },
    {
      id: 'q11_3',
      text: 'Are you eating regularly?',
      type: 'yesno'
    },
    {
      id: 'q11_4',
      text: 'Did you drink enough water today?',
      type: 'yesno'
    },
    {
      id: 'q11_5',
      text: 'How do you feel about your eating habits?',
      type: 'choice',
      options: ['Unhealthy', 'Okay', 'Healthy']
    }
  ],

  // Set 12 - Anxiety Check
  [
    {
      id: 'q12_1',
      text: 'How anxious do you feel right now?',
      type: 'scale',
      min: 1,
      max: 5,
      labels: ['Calm', 'Very anxious']
    },
    {
      id: 'q12_2',
      text: 'Is your mind racing?',
      type: 'yesno'
    },
    {
      id: 'q12_3',
      text: 'Can you relax today?',
      type: 'yesno'
    },
    {
      id: 'q12_4',
      text: 'Did you practice any breathing or calming?',
      type: 'yesno'
    },
    {
      id: 'q12_5',
      text: 'Do you feel safe right now?',
      type: 'yesno'
    }
  ],

  // Set 13 - Movement & Activity
  [
    {
      id: 'q13_1',
      text: 'Did you exercise or move today?',
      type: 'yesno'
    },
    {
      id: 'q13_2',
      text: 'How much did you move around today?',
      type: 'choice',
      options: ['Barely moved', 'Some movement', 'Very active']
    },
    {
      id: 'q13_3',
      text: 'Do you feel physically strong?',
      type: 'yesno'
    },
    {
      id: 'q13_4',
      text: 'How is your posture right now?',
      type: 'choice',
      options: ['Slouched', 'Okay', 'Good']
    },
    {
      id: 'q13_5',
      text: 'Did you stretch or move your body intentionally?',
      type: 'yesno'
    }
  ],

  // Set 14 - Creative Energy
  [
    {
      id: 'q14_1',
      text: 'Did you create anything today?',
      type: 'yesno'
    },
    {
      id: 'q14_2',
      text: 'How creative do you feel?',
      type: 'scale',
      min: 1,
      max: 5,
      labels: ['Blocked', 'Flowing']
    },
    {
      id: 'q14_3',
      text: 'Did you try something new today?',
      type: 'yesno'
    },
    {
      id: 'q14_4',
      text: 'Are your ideas flowing?',
      type: 'yesno'
    },
    {
      id: 'q14_5',
      text: 'Do you feel inspired?',
      type: 'yesno'
    }
  ],

  // Set 15 - Connection Quality
  [
    {
      id: 'q15_1',
      text: 'Did you have a meaningful conversation today?',
      type: 'yesno'
    },
    {
      id: 'q15_2',
      text: 'Do you feel supported by someone?',
      type: 'yesno'
    },
    {
      id: 'q15_3',
      text: 'How lonely do you feel?',
      type: 'scale',
      min: 1,
      max: 5,
      labels: ['Not lonely', 'Very lonely']
    },
    {
      id: 'q15_4',
      text: 'Did you help someone today?',
      type: 'yesno'
    },
    {
      id: 'q15_5',
      text: 'Do you feel understood?',
      type: 'yesno'
    }
  ],

  // Set 16 - Digital Wellness
  [
    {
      id: 'q16_1',
      text: 'How much time on screens today?',
      type: 'choice',
      options: ['Way too much', 'A lot', 'Moderate', 'Very little']
    },
    {
      id: 'q16_2',
      text: 'Did you doom scroll today?',
      type: 'yesno'
    },
    {
      id: 'q16_3',
      text: 'Did you take a screen break?',
      type: 'yesno'
    },
    {
      id: 'q16_4',
      text: 'How do you feel about your phone usage?',
      type: 'choice',
      options: ['Unhealthy', 'Okay', 'Healthy']
    },
    {
      id: 'q16_5',
      text: 'Did you consume positive content today?',
      type: 'yesno'
    }
  ],

  // Set 17 - Work/Study Balance
  [
    {
      id: 'q17_1',
      text: 'How stressed are you about work/study?',
      type: 'scale',
      min: 1,
      max: 5,
      labels: ['Not stressed', 'Very stressed']
    },
    {
      id: 'q17_2',
      text: 'Did you take work breaks today?',
      type: 'yesno'
    },
    {
      id: 'q17_3',
      text: 'Are you overworking yourself?',
      type: 'yesno'
    },
    {
      id: 'q17_4',
      text: 'Do you feel fulfilled by your work?',
      type: 'yesno'
    },
    {
      id: 'q17_5',
      text: 'Work-life balance feels...',
      type: 'choice',
      options: ['Terrible', 'Okay', 'Good']
    }
  ],

  // Set 18 - Joy & Pleasure
  [
    {
      id: 'q18_1',
      text: 'Did you do something fun today?',
      type: 'yesno'
    },
    {
      id: 'q18_2',
      text: 'When did you last genuinely enjoy something?',
      type: 'choice',
      options: ['Can\'t remember', 'This week', 'Today']
    },
    {
      id: 'q18_3',
      text: 'Are you having fun in life?',
      type: 'yesno'
    },
    {
      id: 'q18_4',
      text: 'Did you listen to music you love today?',
      type: 'yesno'
    },
    {
      id: 'q18_5',
      text: 'How joyful do you feel?',
      type: 'scale',
      min: 1,
      max: 5,
      labels: ['No joy', 'Very joyful']
    }
  ],

  // Set 19 - Mindfulness
  [
    {
      id: 'q19_1',
      text: 'Did you take a moment to breathe today?',
      type: 'yesno'
    },
    {
      id: 'q19_2',
      text: 'How present do you feel right now?',
      type: 'scale',
      min: 1,
      max: 5,
      labels: ['Distracted', 'Very present']
    },
    {
      id: 'q19_3',
      text: 'Are you in your head too much?',
      type: 'yesno'
    },
    {
      id: 'q19_4',
      text: 'Did you notice something beautiful today?',
      type: 'yesno'
    },
    {
      id: 'q19_5',
      text: 'Can you be still right now?',
      type: 'yesno'
    }
  ],

  // Set 20 - Personal Growth
  [
    {
      id: 'q20_1',
      text: 'Did you learn something new today?',
      type: 'yesno'
    },
    {
      id: 'q20_2',
      text: 'Are you growing as a person?',
      type: 'yesno'
    },
    {
      id: 'q20_3',
      text: 'How challenged do you feel?',
      type: 'choice',
      options: ['Bored', 'Just right', 'Overwhelmed']
    },
    {
      id: 'q20_4',
      text: 'Did you read or learn anything today?',
      type: 'yesno'
    },
    {
      id: 'q20_5',
      text: 'Do you feel like you\'re evolving?',
      type: 'yesno'
    }
  ],

  // ============================================
  // SET 21-30: LIFESTYLE & HABITS
  // ============================================

  // Set 21 - Sleep Quality
  [
    {
      id: 'q21_1',
      text: 'How many hours did you sleep?',
      type: 'choice',
      options: ['< 5 hours', '5-6 hours', '7-8 hours', '9+ hours']
    },
    {
      id: 'q21_2',
      text: 'Did you have nightmares?',
      type: 'yesno'
    },
    {
      id: 'q21_3',
      text: 'Did you wake up during the night?',
      type: 'yesno'
    },
    {
      id: 'q21_4',
      text: 'Sleep quality was...',
      type: 'choice',
      options: ['Terrible', 'Restless', 'Decent', 'Deep & good']
    },
    {
      id: 'q21_5',
      text: 'Do you have a good sleep routine?',
      type: 'yesno'
    }
  ],

  // Set 22 - Gratitude & Appreciation
  [
    {
      id: 'q22_1',
      text: 'Did you feel grateful today?',
      type: 'yesno'
    },
    {
      id: 'q22_2',
      text: 'Did you thank someone today?',
      type: 'yesno'
    },
    {
      id: 'q22_3',
      text: 'How appreciative do you feel of your life?',
      type: 'scale',
      min: 1,
      max: 5,
      labels: ['Not at all', 'Very appreciative']
    },
    {
      id: 'q22_4',
      text: 'Can you name 3 good things about today?',
      type: 'yesno'
    },
    {
      id: 'q22_5',
      text: 'Do you feel lucky?',
      type: 'yesno'
    }
  ],

  // Set 23 - Boundaries & Rest
  [
    {
      id: 'q23_1',
      text: 'Did you say "no" to something draining today?',
      type: 'yesno'
    },
    {
      id: 'q23_2',
      text: 'Are you respecting your own limits?',
      type: 'yesno'
    },
    {
      id: 'q23_3',
      text: 'How good are you at setting boundaries?',
      type: 'choice',
      options: ['Terrible', 'Learning', 'Good']
    },
    {
      id: 'q23_4',
      text: 'Did you get enough rest today?',
      type: 'yesno'
    },
    {
      id: 'q23_5',
      text: 'Do you feel burnt out?',
      type: 'yesno'
    }
  ],

  // Set 24 - Hobbies & Interests
  [
    {
      id: 'q24_1',
      text: 'Did you spend time on a hobby?',
      type: 'yesno'
    },
    {
      id: 'q24_2',
      text: 'Are you making time for what you love?',
      type: 'yesno'
    },
    {
      id: 'q24_3',
      text: 'How engaged do you feel in your interests?',
      type: 'scale',
      min: 1,
      max: 5,
      labels: ['Lost interest', 'Fully engaged']
    },
    {
      id: 'q24_4',
      text: 'Did you do something just for fun?',
      type: 'yesno'
    },
    {
      id: 'q24_5',
      text: 'Do you have passions you\'re pursuing?',
      type: 'yesno'
    }
  ],

  // Set 25 - Nature & Environment
  [
    {
      id: 'q25_1',
      text: 'Did you see the sky today?',
      type: 'yesno'
    },
    {
      id: 'q25_2',
      text: 'How much time outside today?',
      type: 'choice',
      options: ['None', '< 30 min', '30min - 1hr', '1hr+']
    },
    {
      id: 'q25_3',
      text: 'Did you breathe fresh air?',
      type: 'yesno'
    },
    {
      id: 'q25_4',
      text: 'Do you feel connected to nature?',
      type: 'yesno'
    },
    {
      id: 'q25_5',
      text: 'How does your physical space feel?',
      type: 'choice',
      options: ['Chaotic', 'Okay', 'Peaceful']
    }
  ],

  // Set 26 - Financial Wellness
  [
    {
      id: 'q26_1',
      text: 'How stressed are you about money?',
      type: 'scale',
      min: 1,
      max: 5,
      labels: ['Not stressed', 'Very stressed']
    },
    {
      id: 'q26_2',
      text: 'Do you feel financially secure?',
      type: 'yesno'
    },
    {
      id: 'q26_3',
      text: 'Are money worries affecting your mood?',
      type: 'yesno'
    },
    {
      id: 'q26_4',
      text: 'Did you spend money on yourself today?',
      type: 'yesno'
    },
    {
      id: 'q26_5',
      text: 'Financial situation feels...',
      type: 'choice',
      options: ['Struggling', 'Getting by', 'Stable', 'Comfortable']
    }
  ],

  // Set 27 - Relationships
  [
    {
      id: 'q27_1',
      text: 'Do you feel loved?',
      type: 'yesno'
    },
    {
      id: 'q27_2',
      text: 'Are your relationships healthy?',
      type: 'choice',
      options: ['Toxic', 'Mixed', 'Healthy']
    },
    {
      id: 'q27_3',
      text: 'Did you feel close to someone today?',
      type: 'yesno'
    },
    {
      id: 'q27_4',
      text: 'How satisfied are you with your relationships?',
      type: 'scale',
      min: 1,
      max: 5,
      labels: ['Unsatisfied', 'Very satisfied']
    },
    {
      id: 'q27_5',
      text: 'Do you have someone to talk to?',
      type: 'yesno'
    }
  ],

  // Set 28 - Identity & Self
  [
    {
      id: 'q28_1',
      text: 'Do you like who you are?',
      type: 'yesno'
    },
    {
      id: 'q28_2',
      text: 'Are you being authentic today?',
      type: 'yesno'
    },
    {
      id: 'q28_3',
      text: 'How confident do you feel?',
      type: 'scale',
      min: 1,
      max: 5,
      labels: ['Not confident', 'Very confident']
    },
    {
      id: 'q28_4',
      text: 'Do you feel good about yourself?',
      type: 'yesno'
    },
    {
      id: 'q28_5',
      text: 'Are you living according to your values?',
      type: 'yesno'
    }
  ],

  // Set 29 - Future Outlook
  [
    {
      id: 'q29_1',
      text: 'How do you feel about the future?',
      type: 'choice',
      options: ['Anxious', 'Uncertain', 'Hopeful', 'Excited']
    },
    {
      id: 'q29_2',
      text: 'Do you have goals you\'re working toward?',
      type: 'yesno'
    },
    {
      id: 'q29_3',
      text: 'Does your life have direction?',
      type: 'yesno'
    },
    {
      id: 'q29_4',
      text: 'How optimistic do you feel?',
      type: 'scale',
      min: 1,
      max: 5,
      labels: ['Pessimistic', 'Very optimistic']
    },
    {
      id: 'q29_5',
      text: 'Are you excited about anything coming up?',
      type: 'yesno'
    }
  ],

  // Set 30 - Coping & Resilience
  [
    {
      id: 'q30_1',
      text: 'How well are you handling challenges?',
      type: 'choice',
      options: ['Poorly', 'Struggling', 'Managing', 'Well']
    },
    {
      id: 'q30_2',
      text: 'Did you use a healthy coping strategy today?',
      type: 'yesno'
    },
    {
      id: 'q30_3',
      text: 'Do you feel resilient?',
      type: 'yesno'
    },
    {
      id: 'q30_4',
      text: 'How strong do you feel emotionally?',
      type: 'scale',
      min: 1,
      max: 5,
      labels: ['Fragile', 'Very strong']
    },
    {
      id: 'q30_5',
      text: 'Can you bounce back from setbacks?',
      type: 'yesno'
    }
  ],

  // ============================================
  // SET 31-40: VARIETY & DEPTH
  // ============================================

  // Set 31 - Sensory Experience
  [
    {
      id: 'q31_1',
      text: 'Did you notice pleasant smells today?',
      type: 'yesno'
    },
    {
      id: 'q31_2',
      text: 'Did you enjoy any tastes today?',
      type: 'yesno'
    },
    {
      id: 'q31_3',
      text: 'How comfortable is your body right now?',
      type: 'choice',
      options: ['Uncomfortable', 'Neutral', 'Comfortable']
    },
    {
      id: 'q31_4',
      text: 'Did you hear something soothing today?',
      type: 'yesno'
    },
    {
      id: 'q31_5',
      text: 'Are you enjoying your senses?',
      type: 'yesno'
    }
  ],

  // Set 32 - Routine & Structure
  [
    {
      id: 'q32_1',
      text: 'Did you follow your routine today?',
      type: 'yesno'
    },
    {
      id: 'q32_2',
      text: 'How structured is your day?',
      type: 'choice',
      options: ['Chaotic', 'Some structure', 'Very structured']
    },
    {
      id: 'q32_3',
      text: 'Do you have healthy habits?',
      type: 'yesno'
    },
    {
      id: 'q32_4',
      text: 'Did you stick to your plans today?',
      type: 'yesno'
    },
    {
      id: 'q32_5',
      text: 'How organized do you feel?',
      type: 'scale',
      min: 1,
      max: 5,
      labels: ['Disorganized', 'Very organized']
    }
  ],

  // Set 33 - Laughter & Lightness
  [
    {
      id: 'q33_1',
      text: 'Did something make you laugh today?',
      type: 'yesno'
    },
    {
      id: 'q33_2',
      text: 'How playful do you feel?',
      type: 'scale',
      min: 1,
      max: 5,
      labels: ['Too serious', 'Very playful']
    },
    {
      id: 'q33_3',
      text: 'Did you have fun today?',
      type: 'yesno'
    },
    {
      id: 'q33_4',
      text: 'Can you be silly?',
      type: 'yesno'
    },
    {
      id: 'q33_5',
      text: 'How light does your heart feel?',
      type: 'choice',
      options: ['Heavy', 'Neutral', 'Light']
    }
  ],

  // Set 34 - Pain & Discomfort
  [
    {
      id: 'q34_1',
      text: 'Are you in physical pain?',
      type: 'yesno'
    },
    {
      id: 'q34_2',
      text: 'How much discomfort are you in?',
      type: 'scale',
      min: 1,
      max: 5,
      labels: ['None', 'A lot']
    },
    {
      id: 'q34_3',
      text: 'Is pain affecting your mood?',
      type: 'yesno'
    },
    {
      id: 'q34_4',
      text: 'Did you take care of your body today?',
      type: 'yesno'
    },
    {
      id: 'q34_5',
      text: 'How does your body feel overall?',
      type: 'choice',
      options: ['Bad', 'Okay', 'Good', 'Great']
    }
  ],

  // Set 35 - Decision Making
  [
    {
      id: 'q35_1',
      text: 'Can you make decisions easily today?',
      type: 'yesno'
    },
    {
      id: 'q35_2',
      text: 'How clear-minded do you feel?',
      type: 'scale',
      min: 1,
      max: 5,
      labels: ['Confused', 'Very clear']
    },
    {
      id: 'q35_3',
      text: 'Do you trust your judgment?',
      type: 'yesno'
    },
    {
      id: 'q35_4',
      text: 'Are you overthinking things?',
      type: 'yesno'
    },
    {
      id: 'q35_5',
      text: 'Mental clarity feels...',
      type: 'choice',
      options: ['Foggy', 'Okay', 'Sharp']
    }
  ],

  // Set 36 - Safety & Security
  [
    {
      id: 'q36_1',
      text: 'Do you feel safe where you are?',
      type: 'yesno'
    },
    {
      id: 'q36_2',
      text: 'How secure do you feel in life?',
      type: 'scale',
      min: 1,
      max: 5,
      labels: ['Insecure', 'Very secure']
    },
    {
      id: 'q36_3',
      text: 'Are you worried about your safety?',
      type: 'yesno'
    },
    {
      id: 'q36_4',
      text: 'Do you have shelter and basic needs?',
      type: 'yesno'
    },
    {
      id: 'q36_5',
      text: 'How stable does your life feel?',
      type: 'choice',
      options: ['Unstable', 'Somewhat stable', 'Very stable']
    }
  ],

  // Set 37 - Expression & Voice
  [
    {
      id: 'q37_1',
      text: 'Did you express yourself today?',
      type: 'yesno'
    },
    {
      id: 'q37_2',
      text: 'Do you feel heard?',
      type: 'yesno'
    },
    {
      id: 'q37_3',
      text: 'How comfortable are you speaking up?',
      type: 'scale',
      min: 1,
      max: 5,
      labels: ['Silent', 'Very vocal']
    },
    {
      id: 'q37_4',
      text: 'Did you share how you feel with someone?',
      type: 'yesno'
    },
    {
      id: 'q37_5',
      text: 'Can you be your true self around others?',
      type: 'yesno'
    }
  ],

  // Set 38 - Accomplishment
  [
    {
      id: 'q38_1',
      text: 'Did you finish something today?',
      type: 'yesno'
    },
    {
      id: 'q38_2',
      text: 'How accomplished do you feel?',
      type: 'scale',
      min: 1,
      max: 5,
      labels: ['Unproductive', 'Very accomplished']
    },
    {
      id: 'q38_3',
      text: 'Are you making progress on your goals?',
      type: 'yesno'
    },
    {
      id: 'q38_4',
      text: 'Did you cross anything off your to-do list?',
      type: 'yesno'
    },
    {
      id: 'q38_5',
      text: 'Do you feel capable?',
      type: 'yesno'
    }
  ],

  // Set 39 - Compassion & Kindness
  [
    {
      id: 'q39_1',
      text: 'Were you kind to yourself today?',
      type: 'yesno'
    },
    {
      id: 'q39_2',
      text: 'Did you show compassion to someone?',
      type: 'yesno'
    },
    {
      id: 'q39_3',
      text: 'How judgmental are you being toward yourself?',
      type: 'choice',
      options: ['Very harsh', 'Neutral', 'Very kind']
    },
    {
      id: 'q39_4',
      text: 'Did you receive kindness today?',
      type: 'yesno'
    },
    {
      id: 'q39_5',
      text: 'How compassionate do you feel?',
      type: 'scale',
      min: 1,
      max: 5,
      labels: ['Cold', 'Very compassionate']
    }
  ],

  // Set 40 - Overall Satisfaction
  [
    {
      id: 'q40_1',
      text: 'How satisfied are you with your life right now?',
      type: 'scale',
      min: 1,
      max: 5,
      labels: ['Unsatisfied', 'Very satisfied']
    },
    {
      id: 'q40_2',
      text: 'Are you living the life you want?',
      type: 'yesno'
    },
    {
      id: 'q40_3',
      text: 'Do you feel fulfilled?',
      type: 'yesno'
    },
    {
      id: 'q40_4',
      text: 'Would you change anything about today?',
      type: 'yesno'
    },
    {
      id: 'q40_5',
      text: 'Overall, how alive do you feel?',
      type: 'choice',
      options: ['Barely existing', 'Getting by', 'Living', 'Thriving']
    }
  ]
];

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Get a random set of 5 questions
 * Ensures variety by not repeating the last set used
 */
const getRandomQuestionSet = (lastSetIndex = null) => {
  let randomIndex;
  
  do {
    randomIndex = Math.floor(Math.random() * QUESTION_SETS.length);
  } while (randomIndex === lastSetIndex && QUESTION_SETS.length > 1);
  
  return {
    setIndex: randomIndex,
    questions: QUESTION_SETS[randomIndex]
  };
};

/**
 * Get total count of question sets
 */
const getTotalSets = () => QUESTION_SETS.length;

/**
 * Get total count of individual questions
 */
const getTotalQuestions = () => {
  return QUESTION_SETS.reduce((total, set) => total + set.length, 0);
};

// ============================================
// EXPORTS
// ============================================

module.exports = {
  QUESTION_SETS,
  getRandomQuestionSet,
  getTotalSets,
  getTotalQuestions
};
