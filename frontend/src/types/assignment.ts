export enum AssignmentType {
  TEXT = 'text',
  CHOICE = 'choice',
  ATTACHMENT = 'attachment',
}

export enum SubmissionStatus {
  SUBMITTED = 'submitted',
  GRADED = 'graded',
}

/** 选择题题目（兼容后端 questions 数组结构） */
export interface ChoiceQuestion {
  id?: string;
  key?: string;
  questionId?: string;
  title?: string;
  content?: string;
  question?: string;
  multiple?: boolean;
  isMultiple?: boolean;
  multi?: boolean;
  type?: string;
  options?: Array<string | { label?: string; value?: string; key?: string }>;
}

export interface Completeness {
  total: number;
  answered: number;
  percentage: number;
  complete: boolean;
}

export interface Assignment {
  id: string;
  title: string;
  description: string;
  courseId: string;
  lessonId: string;
  teacherId: string;
  type: AssignmentType;
  questions?: ChoiceQuestion[] | { questions?: ChoiceQuestion[]; items?: ChoiceQuestion[] } | any;
  deadline?: Date | string;
  /** 后端计算的截止状态 */
  deadlinePassed?: boolean;
  maxScore: number;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface AssignmentSubmission {
  id: string;
  assignmentId: string;
  studentId: string;
  textAnswer?: string | null;
  choiceAnswers?: any;
  attachmentUrls?: string[] | null;
  status: SubmissionStatus;
  score?: number | null;
  feedback?: string | null;
  gradedAt?: Date | string;
  completeness?: Completeness;
  deadlinePassed?: boolean;
  student?: { id?: string; name?: string; email?: string };
  createdAt: Date | string;
  updatedAt: Date | string;
}
