import {
  Card,
  Typography,
  Form,
  Input,
  Button,
  Space,
  Descriptions,
  Tag,
  message,
  List,
  Avatar,
  Modal,
  Row,
  Col,
  Alert,
  Progress,
  Radio,
  Checkbox,
  Select,
  Empty,
} from 'antd';
import { ArrowLeftOutlined, EditOutlined, StopOutlined, PaperClipOutlined } from '@ant-design/icons';
import { useParams, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { assignmentApi } from '@/api/assignment';
import {
  Assignment,
  AssignmentType,
  SubmissionStatus,
  AssignmentSubmission,
  ChoiceQuestion,
  Completeness,
} from '@/types/assignment';
import { useAuthStore } from '@/store/auth';
import { UserRole } from '@/types/user';

const { Title, Paragraph, Text } = Typography;

/** 兼容后端 questions 的多种存放结构 */
function extractQuestions(assignment: Assignment): ChoiceQuestion[] {
  const q = assignment.questions as any;
  if (Array.isArray(q)) return q;
  if (q && Array.isArray(q.questions)) return q.questions;
  if (q && Array.isArray(q.items)) return q.items;
  return [];
}

function questionKey(q: ChoiceQuestion, index: number): string {
  return String(q.id ?? q.key ?? q.questionId ?? index);
}

function questionTitle(q: ChoiceQuestion, index: number): string {
  return q.title ?? q.content ?? q.question ?? `第 ${index + 1} 题`;
}

function isMultiple(q: ChoiceQuestion): boolean {
  return !!(q.multiple ?? q.isMultiple ?? q.multi ?? q.type === 'multiple');
}

function questionOptions(q: ChoiceQuestion): string[] {
  if (!Array.isArray(q.options)) return [];
  return q.options
    .map((o) => (o && typeof o === 'object' ? String(o.value ?? o.key ?? o.label ?? '') : String(o)))
    .filter((o) => o.trim() !== '');
}

/** 将后端存储的选择题答案规整为表单可用的 { key: string | string[] } */
function normalizeChoiceAnswers(raw: any): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  if (!raw) return result;
  const toArr = (v: any): string[] =>
    (Array.isArray(v) ? v : [v]).filter((x) => x !== undefined && x !== null && `${x}`.trim() !== '').map(String);

  if (Array.isArray(raw)) {
    raw.forEach((entry: any, i: number) => {
      if (entry && typeof entry === 'object') {
        const key = String(entry.questionId ?? entry.question ?? entry.id ?? entry.key ?? i);
        result[key] = toArr(entry.answer ?? entry.value ?? entry.choice);
      } else {
        result[String(i)] = toArr(entry);
      }
    });
  } else if (typeof raw === 'object') {
    Object.keys(raw).forEach((key) => {
      result[key] = toArr(raw[key]);
    });
  }
  return result;
}

/** 依据当前表单内容实时计算完整度 */
function computeLiveCompleteness(
  assignment: Assignment,
  values: { textAnswer?: string; choiceAnswers?: Record<string, any>; attachmentUrls?: string[] },
): Completeness {
  if (assignment.type === AssignmentType.TEXT) {
    const answered = (values.textAnswer ?? '').trim() ? 1 : 0;
    return { total: 1, answered, percentage: answered * 100, complete: answered === 1 };
  }
  if (assignment.type === AssignmentType.ATTACHMENT) {
    const answered = (values.attachmentUrls ?? []).length > 0 ? 1 : 0;
    return { total: 1, answered, percentage: answered * 100, complete: answered === 1 };
  }
  const questions = extractQuestions(assignment);
  if (questions.length === 0) {
    return { total: 0, answered: 0, percentage: 0, complete: false };
  }
  let answered = 0;
  questions.forEach((q, i) => {
    const v = values.choiceAnswers?.[questionKey(q, i)];
    const len = Array.isArray(v) ? v.length : v !== undefined && `${v}`.trim() !== '' ? 1 : 0;
    if (len > 0) answered += 1;
  });
  return {
    total: questions.length,
    answered,
    percentage: Math.round((answered / questions.length) * 100),
    complete: answered === questions.length,
  };
}

export default function AssignmentPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [assignment, setAssignment] = useState<Assignment | null>(null);
  const [submission, setSubmission] = useState<AssignmentSubmission | null>(null);
  const [submissions, setSubmissions] = useState<AssignmentSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [rejectReason, setRejectReason] = useState<string | null>(null);
  const [form] = Form.useForm();
  const { user } = useAuthStore();

  const isTeacher = user?.role === UserRole.TEACHER;
  const questions = assignment ? extractQuestions(assignment) : [];
  const formValues = Form.useWatch([], form) as
    | { textAnswer?: string; choiceAnswers?: Record<string, any>; attachmentUrls?: string[] }
    | undefined;

  const deadlinePassed =
    !!assignment &&
    (assignment.deadlinePassed ?? (!!assignment.deadline && new Date(assignment.deadline).getTime() <= Date.now()));

  const liveCompleteness =
    assignment && formValues ? computeLiveCompleteness(assignment, formValues) : undefined;

  useEffect(() => {
    if (id) {
      loadAssignment();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const loadAssignment = async () => {
    if (!id) return;
    setLoading(true);
    try {
      const data = await assignmentApi.get(id);
      setAssignment(data);

      if (isTeacher) {
        const subs = await assignmentApi.getSubmissions(id);
        setSubmissions(subs);
      } else {
        const mySub = await assignmentApi.getMySubmission(id);
        setSubmission(mySub);
        if (mySub) {
          form.setFieldsValue({
            textAnswer: mySub.textAnswer ?? '',
            choiceAnswers: normalizeChoiceAnswers(mySub.choiceAnswers),
            attachmentUrls: mySub.attachmentUrls ?? [],
          });
        }
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (values: any) => {
    if (!id || !assignment) return;
    setRejectReason(null);

    const payload: Partial<AssignmentSubmission> =
      assignment.type === AssignmentType.TEXT
        ? { textAnswer: values.textAnswer }
        : assignment.type === AssignmentType.CHOICE
        ? { choiceAnswers: values.choiceAnswers }
        : { attachmentUrls: values.attachmentUrls };

    try {
      const result = await assignmentApi.submit(id, payload);
      // 重复有效提交只更新本人那份记录，由后端保证不产生第二份
      setSubmission(result);
      message.success(submission ? '提交已更新' : '提交成功');
    } catch (error: any) {
      // 被门禁拒绝时不清空表单，原提交（若有）保持不变
      const reason = error.response?.data?.message || '提交失败，请检查作答内容';
      setRejectReason(Array.isArray(reason) ? reason.join('；') : reason);
    }
  };

  const formatAnswersForTeacher = (sub: AssignmentSubmission) => {
    const parts: string[] = [];
    if (sub.textAnswer) parts.push(sub.textAnswer);
    if (sub.choiceAnswers) {
      const normalized = normalizeChoiceAnswers(sub.choiceAnswers);
      const text = Object.entries(normalized)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
        .join('；');
      if (text) parts.push(`选择题答案：${text}`);
    }
    if (sub.attachmentUrls?.length) parts.push(`附件：${sub.attachmentUrls.join(' ')}`);
    return parts.length ? parts.join('\n') : '无作答内容';
  };

  const handleGrade = (sub: AssignmentSubmission) => {
    Modal.confirm({
      title: '批改作业',
      content: (
        <div style={{ marginTop: 16 }}>
          <Paragraph strong>学生答案：</Paragraph>
          <Paragraph style={{ whiteSpace: 'pre-wrap' }}>{formatAnswersForTeacher(sub)}</Paragraph>
        </div>
      ),
      okText: '批改',
      onOk: async () => {
        const score = 85;
        const feedback = '做得很好！';
        try {
          await assignmentApi.grade(sub.id, score, feedback);
          message.success('批改完成');
          loadAssignment();
        } catch (error: any) {
          message.error(error.response?.data?.message || '批改失败');
        }
      },
    });
  };

  const getTypeText = (type: AssignmentType) => {
    switch (type) {
      case AssignmentType.TEXT:
        return '文本题';
      case AssignmentType.CHOICE:
        return '选择题';
      case AssignmentType.ATTACHMENT:
        return '附件提交';
    }
  };

  const getStatusTag = (status: SubmissionStatus) => {
    switch (status) {
      case SubmissionStatus.SUBMITTED:
        return <Tag color="blue">待批改</Tag>;
      case SubmissionStatus.GRADED:
        return <Tag color="green">已批改</Tag>;
    }
  };

  if (loading) {
    return <Card><div style={{ textAlign: 'center', padding: 50 }}>加载中...</div></Card>;
  }

  if (!assignment) {
    return <Card><div style={{ textAlign: 'center', padding: 50 }}>作业不存在</div></Card>;
  }

  const savedCompleteness: Completeness | undefined = submission?.completeness;

  return (
    <div>
      <Space style={{ marginBottom: 24 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(-1)}>
          返回
        </Button>
        <Title level={3} style={{ margin: 0 }}>
          {assignment.title}
        </Title>
        <Tag>{getTypeText(assignment.type)}</Tag>
        {assignment.deadline &&
          (deadlinePassed ? (
            <Tag icon={<StopOutlined />} color="red">
              已截止（{new Date(assignment.deadline).toLocaleString()}）
            </Tag>
          ) : (
            <Tag color="green">进行中（截止 {new Date(assignment.deadline).toLocaleString()}）</Tag>
          ))}
      </Space>

      <Row gutter={24}>
        <Col span={16}>
          <Card title="作业详情">
            <Descriptions column={1}>
              <Descriptions.Item label="作业说明">
                <Paragraph>{assignment.description}</Paragraph>
              </Descriptions.Item>
              <Descriptions.Item label="满分">
                {assignment.maxScore} 分
              </Descriptions.Item>
              {assignment.deadline && (
                <Descriptions.Item label="截止时间">
                  {new Date(assignment.deadline).toLocaleString()}
                  {deadlinePassed && <Text type="danger">（已截止，不能再提交或修改）</Text>}
                </Descriptions.Item>
              )}
            </Descriptions>
          </Card>

          {!isTeacher && (
            <Card title="我的答案" style={{ marginTop: 24 }}>
              <Space style={{ marginBottom: 16 }} wrap>
                {submission && getStatusTag(submission.status)}
                <Text type="secondary">
                  {submission
                    ? `最近提交：${new Date(submission.updatedAt || submission.createdAt).toLocaleString()}`
                    : '尚未提交'}
                </Text>
              </Space>

              {/* 已保存提交的作答完整度 */}
              {savedCompleteness && (
                <div style={{ marginBottom: 16 }}>
                  <Text>作答完整度：</Text>
                  <Progress
                    percent={savedCompleteness.percentage}
                    size="small"
                    status={savedCompleteness.complete ? 'success' : 'active'}
                    style={{ maxWidth: 320, display: 'inline-block', marginInline: 12 }}
                  />
                  <Text type={savedCompleteness.complete ? 'success' : 'warning'}>
                    {savedCompleteness.answered}/{savedCompleteness.total}
                    {assignment.type === AssignmentType.CHOICE ? ' 题已作答' : ' 项'}
                  </Text>
                </div>
              )}

              {submission?.status === SubmissionStatus.GRADED && (
                <div style={{ marginBottom: 16, padding: 16, background: '#f5f5f5', borderRadius: 8 }}>
                  <Paragraph strong>得分：{submission.score} / {assignment.maxScore}</Paragraph>
                  <Paragraph strong>教师反馈：</Paragraph>
                  <Paragraph>{submission.feedback}</Paragraph>
                </div>
              )}

              {deadlinePassed && (
                <Alert
                  style={{ marginBottom: 16 }}
                  type="error"
                  showIcon
                  icon={<StopOutlined />}
                  message="作业已截止"
                  description="截止时间之后不能新增或修改提交；以下为你此前提交的内容（如有）。教师仍可批改。"
                />
              )}

              {rejectReason && (
                <Alert
                  style={{ marginBottom: 16 }}
                  type="error"
                  showIcon
                  message="提交被拒绝，原提交内容已保留"
                  description={rejectReason}
                />
              )}

              <Form form={form} layout="vertical" onFinish={handleSubmit} style={{ marginTop: 16 }}>
                {assignment.type === AssignmentType.TEXT && (
                  <Form.Item
                    name="textAnswer"
                    label="文字答案"
                    rules={[{ required: true, whitespace: true, message: '文本题必须填写文字答案' }]}
                  >
                    <Input.TextArea rows={8} placeholder="请输入你的答案" disabled={deadlinePassed} />
                  </Form.Item>
                )}

                {assignment.type === AssignmentType.CHOICE && (
                  <>
                    {questions.length === 0 && (
                      <Alert
                        style={{ marginBottom: 16 }}
                        type="warning"
                        showIcon
                        message="作业未配置选择题题目"
                        description="请联系任课教师；缺少题目时无法完成选择作答。"
                      />
                    )}
                    {questions.map((q, index) => {
                      const key = questionKey(q, index);
                      const options = questionOptions(q);
                      const multiple = isMultiple(q);
                      return (
                        <Form.Item
                          key={`${key}-${index}`}
                          name={['choiceAnswers', key]}
                          label={`${index + 1}. ${questionTitle(q, index)}${multiple ? '（多选）' : '（单选）'}`}
                          rules={[
                            {
                              required: true,
                              validator: (_, value) =>
                                (Array.isArray(value) ? value.length > 0 : value !== undefined && `${value}`.trim() !== '')
                                  ? Promise.resolve()
                                  : Promise.reject(new Error('请作答该题目，所有题目均须作答')),
                            },
                          ]}
                        >
                          {options.length > 0 ? (
                            multiple ? (
                              <Checkbox.Group
                                options={options.map((o) => ({ label: o, value: o }))}
                                disabled={deadlinePassed}
                              />
                            ) : (
                              <Radio.Group
                                options={options.map((o) => ({ label: o, value: o }))}
                                optionType="default"
                                disabled={deadlinePassed}
                              />
                            )
                          ) : (
                            <Input placeholder="请输入选项" disabled={deadlinePassed} />
                          )}
                        </Form.Item>
                      );
                    })}
                  </>
                )}

                {assignment.type === AssignmentType.ATTACHMENT && (
                  <Form.Item
                    name="attachmentUrls"
                    label="作业附件"
                    rules={[{ required: true, message: '附件作业必须上传至少一个附件' }]}
                    extra="输入附件链接后按回车添加（可添加多个）。"
                  >
                    <Select
                      mode="tags"
                      tokenSeparators={[',', ' ']}
                      placeholder="输入附件链接后回车"
                      suffixIcon={<PaperClipOutlined />}
                      disabled={deadlinePassed}
                      open={false}
                    />
                  </Form.Item>
                )}

                {!deadlinePassed && (
                  <Form.Item>
                    <Space direction="vertical" style={{ width: '100%' }}>
                      <Button type="primary" htmlType="submit" size="large">
                        {submission ? '重新提交（更新本人提交）' : '提交作业'}
                      </Button>
                      {assignment.type === AssignmentType.CHOICE && liveCompleteness && (
                        <Text type="secondary">
                          当前作答进度：{liveCompleteness.answered}/{liveCompleteness.total} 题
                          （{liveCompleteness.percentage}%），需全部作答后方可提交
                        </Text>
                      )}
                    </Space>
                  </Form.Item>
                )}
              </Form>
            </Card>
          )}

          {isTeacher && (
            <Card title="学生提交" style={{ marginTop: 24 }}>
              <List
                dataSource={submissions}
                locale={{ emptyText: <Empty description="暂无提交（作业截止不影响已有提交的批改）" /> }}
                renderItem={(sub) => (
                  <List.Item
                    actions={[
                      <Button type="primary" icon={<EditOutlined />} onClick={() => handleGrade(sub)}>
                        批改
                      </Button>,
                    ]}
                  >
                    <List.Item.Meta
                      avatar={<Avatar>{sub.student?.name?.[0] || sub.studentId?.[0] || 'U'}</Avatar>}
                      title={
                        <Space>
                          {sub.student?.name || sub.studentId || '未知用户'}
                          {getStatusTag(sub.status)}
                        </Space>
                      }
                      description={
                        <Space>
                          <span>提交时间：{new Date(sub.createdAt).toLocaleString()}</span>
                          {sub.score !== null && sub.score !== undefined && <span>得分：{sub.score}</span>}
                        </Space>
                      }
                    />
                  </List.Item>
                )}
              />
            </Card>
          )}
        </Col>
      </Row>
    </div>
  );
}
