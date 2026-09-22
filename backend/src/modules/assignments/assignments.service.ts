import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Assignment, AssignmentType } from '../../common/entities/assignment.entity';
import { AssignmentSubmission, SubmissionStatus } from '../../common/entities/assignment-submission.entity';
import { CourseEnrollment } from '../../common/entities/course-enrollment.entity';

interface ChoiceQuestion {
  id?: string | number;
  multiple?: boolean;
  options?: { value?: string | number; label?: string }[] | string[];
}

type ChoiceValue = string | number | Array<string | number>;

interface SubmitPayload {
  textAnswer?: string | null;
  choiceAnswers?: Record<string, ChoiceValue> | null;
  attachmentUrls?: string[] | null;
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
    return this.assignmentRepository.find({
      where: { courseId },
      relations: ['teacher'],
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string) {
    const assignment = await this.assignmentRepository.findOne({
      where: { id },
      relations: ['teacher', 'lesson'],
    });
    if (!assignment) {
      throw new NotFoundException('作业不存在');
    }
    return assignment;
  }

  async create(userId: string, data: Partial<Assignment>) {
    const assignment = this.assignmentRepository.create({
      ...data,
      teacherId: userId,
    });
    return this.assignmentRepository.save(assignment);
  }

  /**
   * 作业提交门禁：
   * 1. 仅本人已报名课程的作业可提交
   * 2. 超过截止时间不得新增或修改
   * 3. 按题型校验内容（文本题需有文字答案，选择题需全部作答）
   * 4. 校验失败拒绝提交并保留原提交
   * 5. 重复有效提交更新同一条记录，不会产生第二份
   */
  async submit(studentId: string, assignmentId: string, data: SubmitPayload) {
    const assignment = await this.assignmentRepository.findOne({ where: { id: assignmentId } });
    if (!assignment) {
      throw new NotFoundException('作业不存在');
    }

    const enrollment = await this.enrollmentRepository.findOne({
      where: { studentId, courseId: assignment.courseId },
    });
    if (!enrollment) {
      throw new ForbiddenException('未报名该课程，无法提交作业');
    }

    if (assignment.deadline && new Date(assignment.deadline).getTime() <= Date.now()) {
      const reason = '作业已截止，不能新增或修改提交';
      await this.recordRejectReason(studentId, assignmentId, reason);
      throw new ForbiddenException(reason);
    }

    const rejectReason = this.validatePayload(assignment, data);
    if (rejectReason) {
      await this.recordRejectReason(studentId, assignmentId, rejectReason);
      throw new BadRequestException(rejectReason);
    }

    const existingSubmission = await this.submissionRepository.findOne({
      where: { studentId, assignmentId },
    });

    if (existingSubmission) {
      existingSubmission.textAnswer = assignment.type === AssignmentType.TEXT ? data.textAnswer!.trim() : null;
      existingSubmission.choiceAnswers = assignment.type === AssignmentType.CHOICE ? data.choiceAnswers! : null;
      existingSubmission.attachmentUrls = assignment.type === AssignmentType.ATTACHMENT
        ? (data.attachmentUrls || []).map((url) => url.trim()).filter(Boolean)
        : null;
      existingSubmission.status = SubmissionStatus.SUBMITTED;
      existingSubmission.score = null;
      existingSubmission.feedback = null;
      existingSubmission.gradedAt = null;
      existingSubmission.lastRejectReason = null;
      return this.submissionRepository.save(existingSubmission);
    }

    const submission = this.submissionRepository.create({
      studentId,
      assignmentId,
      textAnswer: assignment.type === AssignmentType.TEXT ? data.textAnswer!.trim() : null,
      choiceAnswers: assignment.type === AssignmentType.CHOICE ? data.choiceAnswers! : null,
      attachmentUrls: assignment.type === AssignmentType.ATTACHMENT
        ? (data.attachmentUrls || []).map((url) => url.trim()).filter(Boolean)
        : null,
      status: SubmissionStatus.SUBMITTED,
      lastRejectReason: null,
    });
    return this.submissionRepository.save(submission);
  }

  /**
   * 按题型校验提交内容，返回拒绝原因；校验通过返回 null。
   */
  private validatePayload(assignment: Assignment, data: SubmitPayload): string | null {
    if (!data || typeof data !== 'object') {
      return '提交内容缺失';
    }

    switch (assignment.type) {
      case AssignmentType.TEXT: {
        const text = typeof data.textAnswer === 'string' ? data.textAnswer.trim() : '';
        if (!text) {
          return '文本题必须填写文字答案';
        }
        return null;
      }
      case AssignmentType.CHOICE: {
        const questions: ChoiceQuestion[] = Array.isArray(assignment.questions) ? assignment.questions : [];
        const answers: Record<string, ChoiceValue> | null =
          data.choiceAnswers && typeof data.choiceAnswers === 'object' && !Array.isArray(data.choiceAnswers)
            ? data.choiceAnswers
            : null;
        if (!answers) {
          return '选择题必须按要求全部作答';
        }
        if (questions.length === 0) {
          return '作业缺少选择题配置，请联系教师';
        }
        for (const question of questions) {
          const key = question.id !== undefined ? String(question.id) : '';
          const answer = answers[key];
          const optionValues = (Array.isArray(question.options) ? question.options : []).map((option) =>
            typeof option === 'string' || typeof option === 'number' ? String(option) : String(option.value),
          );

          if (question.multiple) {
            if (!Array.isArray(answer) || answer.length === 0) {
              return '选择题必须按要求全部作答（多选题不能留空）';
            }
            if (optionValues.length > 0 && answer.some((v) => !optionValues.includes(String(v)))) {
              return '选择题答案包含无效选项，请按题目要求作答';
            }
          } else {
            if (Array.isArray(answer) || answer === undefined || answer === null || answer === '') {
              return '选择题必须按要求全部作答（单选题不能留空或多选）';
            }
            if (optionValues.length > 0 && !optionValues.includes(String(answer))) {
              return '选择题答案包含无效选项，请按题目要求作答';
            }
          }
        }
        return null;
      }
      case AssignmentType.ATTACHMENT: {
        const urls = Array.isArray(data.attachmentUrls)
          ? data.attachmentUrls.map((url) => (typeof url === 'string' ? url.trim() : '')).filter(Boolean)
          : [];
        if (urls.length === 0) {
          return '附件作业必须上传至少一个附件';
        }
        return null;
      }
      default:
        return '题型不符，无法提交';
    }
  }

  /**
   * 拒绝提交时把原因记录到已有提交上（不动答案与批改结果）；
   * 尚无提交记录则不新增记录。
   */
  private async recordRejectReason(studentId: string, assignmentId: string, reason: string) {
    const existingSubmission = await this.submissionRepository.findOne({
      where: { studentId, assignmentId },
    });
    if (existingSubmission) {
      existingSubmission.lastRejectReason = reason;
      await this.submissionRepository.save(existingSubmission);
    }
  }

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
    return this.submissionRepository.findOne({
      where: { studentId, assignmentId },
    });
  }
}
