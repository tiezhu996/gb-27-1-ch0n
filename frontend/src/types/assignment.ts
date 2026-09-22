export enum AssignmentType {
  TEXT = 'text',
  CHOICE = 'choice',
  ATTACHMENT = 'attachment',
}

export enum SubmissionStatus {
  SUBMITTED = 'submitted',
  GRADED = 'graded',
}

export interface ChoiceQuestionOption {
  label?: string;
  value?: string | number;
}

export interface ChoiceQuestion {
  id: string | number;
  title?: string;
  question?: string;
  multiple?: boolean;
  options?: ChoiceQuestionOption[] | string[];
}

export interface Assignment {
  id: string;
  title: string;
  description: string;
  courseId: string;
  lessonId: string;
  teacherId: string;
  type: AssignmentType;
  questions?: ChoiceQuestion[] | any;
  deadline?: Date;
  maxScore: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AssignmentSubmission {
  id: string;
  assignmentId: string;
  studentId: string;
  textAnswer?: string;
  choiceAnswers?: Record<string, string | number | Array<string | number>>;
  attachmentUrls?: string[];
  status: SubmissionStatus;
  score?: number;
  feedback?: string;
  lastRejectReason?: string;
  gradedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  student?: {
    id: string;
    name: string;
    email?: string;
  };
}
