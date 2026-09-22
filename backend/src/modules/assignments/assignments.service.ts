import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, QueryFailedError } from 'typeorm';
import { Assignment, AssignmentType } from '../../common/entities/assignment.entity';
import { AssignmentSubmission, SubmissionStatus } from '../../common/entities/assignment-submission.entity';
import { CourseEnrollment } from '../../common/entities/course-enrollment.entity';

/** 作答完整度 */
export interface Completeness {
  /** 需作答的条目数（文本题/附件题为 1，选择题为题目数） */
  total: number;
  /** 已有效作答的条目数 */
  answered: number;
  /** 完整度百分比 0-100 */
  percentage: number;
  /** 是否全部作答完毕 */
  complete: boolean;
}

interface NormalizedQuestion {
  key: string;
  label: string;
  multiple: boolean;
  options: string[];
}

@Injectable()
export class AssignmentsService {
  constructor(
    @InjectRepository(Assignment)
    private readonly assignmentRepository: Repository<Assignment>,
    @InjectRepository(AssignmentSubmission)
    private readonly submissionRepository: Repository<AssignmentSubmission>,
    @InjectRepository(CourseEnrollment)
    private readonly enrollmentRepository: Repository<CourseEnrollment>,
  ) {}

  async findByCourse(courseId: string) {
    const assignments = await this.assignmentRepository.find({
      where: { courseId },
      relations: ['teacher'],
      order: { createdAt: 'DESC' },
    });
    return assignments.map((a) => this.toAssignmentVO(a));
  }

  async findOne(id: string) {
    const assignment = await this.assignmentRepository.findOne({
      where: { id },
      relations: ['teacher', 'lesson'],
    });
    if (!assignment) {
      throw new NotFoundException('作业不存在');
    }
    return this.toAssignmentVO(assignment);
  }

  async create(userId: string, data: Partial<Assignment>) {
    const assignment = this.assignmentRepository.create({
      ...data,
      teacherId: userId,
    });
    return this.assignmentRepository.save(assignment);
  }

  /**
   * 学生提交 / 重新提交作业。
   * 门禁顺序：报名校验 → 截止校验 → 题型与作答内容校验，
   * 任何一步不通过都直接拒绝，不会写入或覆盖任何已有提交。
   */
  async submit(studentId: string, assignmentId: string, data: Partial<AssignmentSubmission>) {
    const assignment = await this.assignmentRepository.findOne({ where: { id: assignmentId } });
    if (!assignment) {
      throw new NotFoundException('作业不存在');
    }

    // 1. 只能提交本人已报名课程中的作业
    const enrollment = await this.enrollmentRepository.findOne({
      where: { studentId, courseId: assignment.courseId },
    });
    if (!enrollment) {
      throw new ForbiddenException('未报名该课程，不能提交此作业');
    }

    // 2. 截止后不得新增或修改
    if (this.isDeadlinePassed(assignment)) {
      throw new ForbiddenException(
        `作业已于 ${new Date(assignment.deadline!).toLocaleString('zh-CN')} 截止，不能再提交或修改`,
      );
    }

    // 3. 题型与作答内容校验（不通过则原提交保持不变）
    this.validateContent(assignment, data);

    // 校验通过后才查库，保证被拒绝时原提交原样保留
    let submission = await this.submissionRepository.findOne({
      where: { studentId, assignmentId },
    });

    if (submission) {
      // 重复有效提交：仅更新本人作答内容，不产生第二份记录，且不动教师评分
      submission.textAnswer = data.textAnswer ?? null;
      submission.choiceAnswers = data.choiceAnswers ?? null;
      submission.attachmentUrls = data.attachmentUrls ?? null;
    } else {
      submission = this.submissionRepository.create({
        studentId,
        assignmentId,
        textAnswer: data.textAnswer ?? null,
        choiceAnswers: data.choiceAnswers ?? null,
        attachmentUrls: data.attachmentUrls ?? null,
        status: SubmissionStatus.SUBMITTED,
      });
    }

    try {
      const saved = await this.submissionRepository.save(submission);
      return this.toSubmissionVO(saved, assignment);
    } catch (error) {
      // 并发下唯一约束兜底：重新拉取本人唯一记录并更新，而不是新建第二份
      if (error instanceof QueryFailedError && (error as any).driverError?.code === '23505') {
        const existing = await this.submissionRepository.findOneOrFail({
          where: { studentId, assignmentId },
        });
        existing.textAnswer = data.textAnswer ?? null;
        existing.choiceAnswers = data.choiceAnswers ?? null;
        existing.attachmentUrls = data.attachmentUrls ?? null;
        const saved = await this.submissionRepository.save(existing);
        return this.toSubmissionVO(saved, assignment);
      }
      throw error;
    }
  }

  // 截止时间不影响教师批改既有提交
  async grade(teacherId: string, submissionId: string, score: number, feedback: string) {
    const submission = await this.submissionRepository.findOne({
      where: { id: submissionId },
      relations: ['assignment'],
    });

    if (!submission) {
      throw new NotFoundException('提交不存在');
    }
    if (submission.assignment.teacherId !== teacherId) {
      throw new ForbiddenException('无权批改此作业');
    }

    submission.score = score;
    submission.feedback = feedback;
    submission.status = SubmissionStatus.GRADED;
    submission.gradedAt = new Date();

    return this.submissionRepository.save(submission);
  }

  async findSubmissionsByAssignment(assignmentId: string) {
    return this.submissionRepository.find({
      where: { assignmentId },
      relations: ['student'],
      order: { createdAt: 'DESC' },
    });
  }

  async findMySubmission(studentId: string, assignmentId: string) {
    const assignment = await this.assignmentRepository.findOne({ where: { id: assignmentId } });
    if (!assignment) {
      throw new NotFoundException('作业不存在');
    }
    const submission = await this.submissionRepository.findOne({
      where: { studentId, assignmentId },
    });
    if (!submission) {
      return null;
    }
    return this.toSubmissionVO(submission, assignment);
  }

  // --------- 校验与组装辅助方法 ---------

  private isDeadlinePassed(assignment: Assignment): boolean {
    return !!assignment.deadline && new Date(assignment.deadline).getTime() <= Date.now();
  }

  /** 按作业题型校验作答内容，不满足要求直接抛出异常，不触碰数据库 */
  private validateContent(assignment: Assignment, data: Partial<AssignmentSubmission>): void {
    switch (assignment.type) {
      case AssignmentType.TEXT: {
        const text = typeof data.textAnswer === 'string' ? data.textAnswer.trim() : '';
        if (!text) {
          const hasOtherContent =
            this.hasChoiceContent(data.choiceAnswers) || (data.attachmentUrls?.length ?? 0) > 0;
          throw new BadRequestException(
            hasOtherContent ? '提交内容与题型不符：文本题必须填写文字答案' : '文本题必须填写文字答案',
          );
        }
        return;
      }

      case AssignmentType.CHOICE: {
        const answers = this.normalizeChoiceAnswers(data.choiceAnswers);
        if (this.hasTextContent(data.textAnswer) || (data.attachmentUrls?.length ?? 0) > 0) {
          throw new BadRequestException('提交内容与题型不符：选择题请通过选项作答');
        }

        const questions = this.normalizeQuestions(assignment);
        if (questions.length === 0) {
          // 题目结构缺失时至少要携带非空选择答案
          if (answers.size === 0) {
            throw new BadRequestException('选择题必须按要求作答，未检测到任何选项答案');
          }
          return;
        }

        for (const [i, q] of questions.entries()) {
          const selected = answers.get(q.key) ?? answers.get(String(i)) ?? [];
          if (selected.length === 0) {
            throw new BadRequestException(`选择题存在未作答题目：${q.label}未作答，需全部作答后方可提交`);
          }
          if (!q.multiple && selected.length > 1) {
            throw new BadRequestException(`${q.label}为单选题，只能选择一个选项`);
          }
          if (q.options.length > 0) {
            const invalid = selected.find((s) => !q.options.includes(s));
            if (invalid !== undefined) {
              throw new BadRequestException(`${q.label}选择了无效选项“${invalid}”`);
            }
          }
        }
        return;
      }

      case AssignmentType.ATTACHMENT: {
        const urls = Array.isArray(data.attachmentUrls)
          ? data.attachmentUrls.map((u) => (typeof u === 'string' ? u.trim() : '')).filter(Boolean)
          : [];
        if (urls.length === 0) {
          const hasOtherContent = this.hasTextContent(data.textAnswer) || this.hasChoiceContent(data.choiceAnswers);
          throw new BadRequestException(
            hasOtherContent ? '提交内容与题型不符：附件作业必须上传至少一个附件' : '附件作业必须上传至少一个附件',
          );
        }
        return;
      }

      default:
        throw new BadRequestException('不支持的作业题型');
    }
  }

  /** 计算作答完整度（用于作业页展示，不参与门禁判定） */
  private computeCompleteness(assignment: Assignment, submission: AssignmentSubmission | null): Completeness {
    if (!submission) {
      return { total: 0, answered: 0, percentage: 0, complete: false };
    }

    if (assignment.type === AssignmentType.TEXT) {
      const answered = this.hasTextContent(submission.textAnswer) ? 1 : 0;
      return { total: 1, answered, percentage: answered * 100, complete: answered === 1 };
    }

    if (assignment.type === AssignmentType.ATTACHMENT) {
      const answered = (submission.attachmentUrls?.filter((u) => u && u.trim()).length ?? 0) > 0 ? 1 : 0;
      return { total: 1, answered, percentage: answered * 100, complete: answered === 1 };
    }

    // 选择题
    const questions = this.normalizeQuestions(assignment);
    const answers = this.normalizeChoiceAnswers(submission.choiceAnswers);
    if (questions.length === 0) {
      const answered = answers.size;
      return { total: answered, answered, percentage: answered > 0 ? 100 : 0, complete: answered > 0 };
    }
    let answered = 0;
    questions.forEach((q, i) => {
      const selected = answers.get(q.key) ?? answers.get(String(i)) ?? [];
      if (selected.length > 0) {
        answered += 1;
      }
    });
    return {
      total: questions.length,
      answered,
      percentage: Math.round((answered / questions.length) * 100),
      complete: answered === questions.length,
    };
  }

  private toAssignmentVO(assignment: Assignment) {
    return {
      ...assignment,
      deadlinePassed: this.isDeadlinePassed(assignment),
    };
  }

  private toSubmissionVO(submission: AssignmentSubmission, assignment: Assignment) {
    return {
      ...submission,
      completeness: this.computeCompleteness(assignment, submission),
      deadlinePassed: this.isDeadlinePassed(assignment),
    };
  }

  /** 兼容多种选择题题目结构：数组、{ questions: [] }、{ items: [] } */
  private extractRawQuestions(assignment: Assignment): any[] {
    const q = assignment.questions as any;
    if (Array.isArray(q)) return q;
    if (q && Array.isArray(q.questions)) return q.questions;
    if (q && Array.isArray(q.items)) return q.items;
    return [];
  }

  private normalizeQuestions(assignment: Assignment): NormalizedQuestion[] {
    return this.extractRawQuestions(assignment).map((q, i) => {
      const rawOptions = Array.isArray(q?.options) ? q.options : [];
      const options = rawOptions
        .map((o: any) => (o && typeof o === 'object' ? o.value ?? o.key ?? o.label : o))
        .filter((o: any) => o !== undefined && o !== null && `${o}`.trim() !== '')
        .map((o: any) => String(o));
      return {
        key: String(q?.id ?? q?.key ?? q?.questionId ?? i),
        label: `第 ${i + 1} 题`,
        multiple: !!(q?.multiple ?? q?.isMultiple ?? q?.multi ?? q?.type === 'multiple'),
        options,
      };
    });
  }

  /**
   * 兼容多种选择题答案结构：
   * - { 题目id: 选项 } / { 题目id: [选项...] }
   * - [{ questionId, answer }]
   * - [选项, 选项...]（按题目顺序）
   */
  private normalizeChoiceAnswers(raw: any): Map<string, string[]> {
    const map = new Map<string, string[]>();
    if (!raw) return map;

    if (Array.isArray(raw)) {
      raw.forEach((entry, i) => {
        if (entry && typeof entry === 'object') {
          const key = String(entry.questionId ?? entry.question ?? entry.id ?? entry.key ?? i);
          map.set(key, this.toAnswerArray(entry.answer ?? entry.value ?? entry.choice));
        } else {
          map.set(String(i), this.toAnswerArray(entry));
        }
      });
    } else if (typeof raw === 'object') {
      Object.keys(raw).forEach((key) => map.set(key, this.toAnswerArray(raw[key])));
    }
    return map;
  }

  private toAnswerArray(answer: any): string[] {
    if (answer === undefined || answer === null || answer === '') return [];
    return (Array.isArray(answer) ? answer : [answer])
      .map((a) => String(a))
      .filter((a) => a.trim() !== '');
  }

  private hasTextContent(text: string | null | undefined): boolean {
    return typeof text === 'string' && text.trim().length > 0;
  }

  private hasChoiceContent(raw: any): boolean {
    return this.normalizeChoiceAnswers(raw).size > 0;
  }
}
